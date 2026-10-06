import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDuration } from '../config/duration.js';
import type { GateConfig } from '../config/schema.js';
import { runShell, type Executor } from '../core/exec.js';
import type { GateSnapshot } from '../core/run-store.js';
import { runBrowserGate } from './browser-gate.js';
import { parseGateOutput } from './parsers/index.js';
import { freePort, hasNpmScript, serveUntilReady } from './serve.js';
import type { Failure, TestCounts } from './parsers/types.js';

export interface GateResult {
  name: string;
  level: GateConfig['level'];
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  failures: Failure[];
  tests?: TestCounts;
  structured: boolean;
  logFile: string;
}

export interface GateRunContext {
  /** Where commands run: the host, or the run's sandbox. */
  exec?: Executor;
  cwd: string;
  env: Record<string, string>;
  logsDir: string;
  /** e.g. `c12` or `baseline`; part of the log file name. */
  label: string;
  maxCmdTimeoutMs: number;
  redact: (s: string) => string;
  signal?: AbortSignal;
  /** Browser for `kind = "browser"` gates; tests inject a fake. Default: detect one. */
  browser?: Parameters<typeof runBrowserGate>[2];
}

export async function runGate(gate: GateConfig, ctx: GateRunContext): Promise<GateResult> {
  if (gate.kind === 'browser') return runServedBrowserGate(gate, ctx);
  const logFile = join(ctx.logsDir, `gate-${ctx.label}-${gate.name}.log`);
  const timeoutMs = Math.min(parseDuration(gate.timeout), ctx.maxCmdTimeoutMs);
  const r = await (ctx.exec ?? runShell)(gate.run, {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutMs,
    logPath: logFile,
    redact: ctx.redact,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const parsed = parseGateOutput(gate.parser, r.output, {
    gate: gate.name,
    exitCode: r.exitCode,
    cwd: ctx.cwd,
  });
  return {
    name: gate.name,
    level: gate.level,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    failures: parsed.failures,
    ...(parsed.tests ? { tests: parsed.tests } : {}),
    structured: parsed.structured,
    logFile,
  };
}

/**
 * Start the app with `gate.run` on a free port, then check `gate.url` in a real browser.
 * Runs on the host: a docker sandbox's server isn't reachable from the host browser.
 */
async function runServedBrowserGate(gate: GateConfig, ctx: GateRunContext): Promise<GateResult> {
  const logFile = join(ctx.logsDir, `gate-${ctx.label}-${gate.name}.log`);
  const started = Date.now();
  const result = (exitCode: number, failures: Failure[], tests?: TestCounts): GateResult => ({
    name: gate.name,
    level: gate.level,
    exitCode,
    timedOut: false,
    durationMs: Date.now() - started,
    failures,
    ...(tests ? { tests } : {}),
    structured: true,
    logFile,
  });
  if (gate.requires_script && !(await hasNpmScript(ctx.cwd, gate.requires_script))) {
    await writeFile(logFile, `skipped: no "${gate.requires_script}" script yet\n`);
    return result(0, [], { total: 0, passed: 0, failed: 0, skipped: 0 });
  }
  const port = await freePort();
  const url = gate.url.replaceAll('${PORT}', String(port));
  const timeoutMs = Math.min(parseDuration(gate.timeout), ctx.maxCmdTimeoutMs);
  let served;
  try {
    served = await serveUntilReady(gate.run, {
      cwd: ctx.cwd,
      env: { ...ctx.env, PORT: String(port) },
      url,
      timeoutMs: Math.min(timeoutMs, 60_000),
    });
  } catch (err) {
    const msg = ctx.redact(err instanceof Error ? err.message : String(err));
    await writeFile(logFile, `${msg}\n`);
    return result(1, [{ id: `${gate.name}:serve`, message: msg.split('\n')[0] ?? msg }]);
  }
  try {
    return await runBrowserGate(
      { name: gate.name, level: gate.level, script: gate.script, url },
      ctx,
      ctx.browser,
    );
  } finally {
    await served.stop();
  }
}

/** Gates run one after another (they often share build output), fast ones first as configured. */
export async function runGates(
  gates: readonly GateConfig[],
  ctx: GateRunContext,
): Promise<GateResult[]> {
  const out: GateResult[] = [];
  for (const g of gates) out.push(await runGate(g, ctx));
  return out;
}

export function snapshot(r: GateResult): GateSnapshot {
  return {
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    failureIds: r.failures.map((f) => f.id),
    ...(r.tests ? { tests: r.tests } : {}),
  };
}

export const toBaseline = (results: readonly GateResult[]): Record<string, GateSnapshot> =>
  Object.fromEntries(results.map((r) => [r.name, snapshot(r)]));
