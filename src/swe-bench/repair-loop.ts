import type { Run } from '../core/run.js';
import type { LocalizationResult } from './localize.js';
import type { ReproTest, ReproResult } from './reproduce.js';
import { runReproTest, writeReproTest, cleanReproTest } from './reproduce.js';
import { extractPatchDiff, summarizePatch, type PatchDiff } from './patch-diff.js';
import { runGates, type GateResult, type GateRunContext } from '../verify/gates.js';
import { readFile } from 'node:fs/promises';

/**
 * Self-healing repair loop for SWE-bench-style issue fixes.
 *
 * The loop:
 * 1. Agent edits code based on localization
 * 2. Run reproduction test (must go red → green)
 * 3. Run regression tests (must stay green)
 * 4. If any fail: feed failure info back to agent
 * 5. Repeat until both pass or max rounds reached
 */

export interface RepairState {
  round: number;
  reproResult: ReproResult | null;
  gateResults: GateResult[];
  allTestsPass: boolean;
  reproFixed: boolean;
  regressionPassed: boolean;
  patch: PatchDiff | null;
}

export interface RepairLoopConfig {
  reproTest: ReproTest;
  localization: LocalizationResult;
  baseCommit: string;
  maxRounds: number;
  requireFailToPass: boolean;
  requirePassToPass: boolean;
}

export interface RepairOutcome {
  success: boolean;
  rounds: number;
  finalState: RepairState;
  failureReason?: string;
}

/**
 * Check if a gate result passed (exit code 0 and no failures).
 */
function gatePassed(result: GateResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.failures.length === 0;
}

/**
 * Get output from a gate result's log file.
 */
async function getGateOutput(result: GateResult): Promise<string> {
  try {
    const content = await readFile(result.logFile, 'utf8');
    return content.slice(-1000);
  } catch {
    return `(exit code ${result.exitCode})`;
  }
}

/**
 * Build an initial repair state.
 */
export function initialRepairState(): RepairState {
  return {
    round: 0,
    reproResult: null,
    gateResults: [],
    allTestsPass: false,
    reproFixed: false,
    regressionPassed: false,
    patch: null,
  };
}

/**
 * Run one round of the repair loop checks.
 */
export async function runRepairChecks(
  run: Run,
  config: RepairLoopConfig,
  state: RepairState,
): Promise<RepairState> {
  const { reproTest, baseCommit, requireFailToPass, requirePassToPass } = config;
  const worktree = run.worktree;
  const env = run.childEnv;

  state.round++;

  await writeReproTest(worktree, reproTest);
  const reproResult = await runReproTest(worktree, reproTest, env);
  state.reproResult = reproResult;
  state.reproFixed = reproResult.pass;

  run.events.emit('repair.repro_check', {
    round: state.round,
    pass: reproResult.pass,
    output: reproResult.output.slice(-500),
  });

  if (requirePassToPass) {
    const gateCtx: GateRunContext = {
      cwd: worktree,
      env,
      logsDir: run.store.logsDir,
      label: `repair-r${state.round}`,
      maxCmdTimeoutMs: run.maxCmdTimeoutMs,
      redact: (s: string) => run.redactor.text(s),
    };
    const gateResults = await runGates(run.config.gates, gateCtx);
    state.gateResults = gateResults;
    state.regressionPassed = gateResults.every(gatePassed);

    run.events.emit('repair.regression_check', {
      round: state.round,
      pass: state.regressionPassed,
      gates: gateResults.map((g) => ({ name: g.name, pass: gatePassed(g) })),
    });
  } else {
    state.regressionPassed = true;
  }

  const passConditions = [];
  if (requireFailToPass) passConditions.push(state.reproFixed);
  if (requirePassToPass) passConditions.push(state.regressionPassed);

  state.allTestsPass = passConditions.every(Boolean);

  if (state.allTestsPass) {
    const patch = await extractPatchDiff(
      worktree,
      run.config.sweBench.patch_context_lines,
      baseCommit,
    );
    state.patch = patch;
    run.events.emit('repair.patch_extracted', { summary: summarizePatch(patch) });
  }

  await cleanReproTest(worktree);

  return state;
}

/**
 * Build a failure message for the agent to fix forward.
 */
export async function buildFailureMessage(
  state: RepairState,
  config: RepairLoopConfig,
): Promise<string> {
  const sections: string[] = [];

  sections.push(`[repair] Round ${state.round}/${config.maxRounds} failed.`);
  sections.push('');

  if (config.requireFailToPass && !state.reproFixed) {
    sections.push('## Reproduction Test Still Fails');
    sections.push('The reproduction test should PASS after your fix, but it still fails:');
    sections.push('```');
    sections.push(state.reproResult?.output.slice(-2000) ?? '(no output)');
    sections.push('```');
    sections.push('');
  }

  if (config.requirePassToPass && !state.regressionPassed) {
    const failed = state.gateResults.filter((g) => !gatePassed(g));
    sections.push('## Regression Tests Fail');
    sections.push('These gates failed (your fix broke existing functionality):');
    for (const gate of failed) {
      const output = await getGateOutput(gate);
      sections.push(`- ${gate.name}: ${output.slice(-500)}`);
    }
    sections.push('');
  }

  sections.push('Fix the code and try again. Do not give up on the original issue.');

  return sections.join('\n');
}

/**
 * Check if the repair loop should continue.
 */
export function shouldContinue(state: RepairState, config: RepairLoopConfig): boolean {
  if (state.allTestsPass) return false;
  if (state.round >= config.maxRounds) return false;
  return true;
}

/**
 * Build a success message after the repair loop completes.
 */
export function buildSuccessMessage(state: RepairState): string {
  const sections: string[] = [];

  sections.push('[repair] All checks pass.');
  sections.push('');

  if (state.patch) {
    sections.push('## Patch Summary');
    sections.push(summarizePatch(state.patch));
    sections.push('');
    sections.push('## Changed Files');
    for (const file of state.patch.files) {
      sections.push(`- ${file}`);
    }
  }

  return sections.join('\n');
}

/**
 * Determine the outcome after the repair loop ends.
 */
export function determineOutcome(state: RepairState, config: RepairLoopConfig): RepairOutcome {
  if (state.allTestsPass) {
    return {
      success: true,
      rounds: state.round,
      finalState: state,
    };
  }

  const reasons: string[] = [];
  if (config.requireFailToPass && !state.reproFixed) {
    reasons.push('reproduction test still fails');
  }
  if (config.requirePassToPass && !state.regressionPassed) {
    reasons.push('regression tests fail');
  }

  return {
    success: false,
    rounds: state.round,
    finalState: state,
    failureReason: reasons.join('; ') || 'max rounds exceeded',
  };
}

/**
 * Render the repair state for logging.
 */
export function renderRepairState(state: RepairState): string {
  const parts: string[] = [
    `Round: ${state.round}`,
    `Repro: ${state.reproFixed ? 'PASS' : 'FAIL'}`,
    `Regression: ${state.regressionPassed ? 'PASS' : 'FAIL'}`,
    `Overall: ${state.allTestsPass ? 'SUCCESS' : 'PENDING'}`,
  ];
  return parts.join(' | ');
}
