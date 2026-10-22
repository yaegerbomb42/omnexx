/**
 * SWE-bench execution preset for Omnexx.
 *
 * Optimized for issue-fix tasks: hierarchical fault localization, reproduction test synthesis,
 * fail-to-pass + pass-to-pass gates, and self-healing repair loops.
 *
 * @module swe-bench
 */

export { localize, localizeToFiles, localizeToElements, localizeToLines } from './localize.js';
export { parseStackTraces, extractKeyTerms, renderLocalization } from './localize.js';
export type {
  LocalizationResult,
  LocalizationContext,
  ElementLocation,
  LineLocation,
} from './localize.js';

export { buildSkeleton, renderSkeleton, renderSkeletons } from './skeleton.js';
export type { FileSkeleton, SkeletonEntry } from './skeleton.js';

export {
  generateReproTest,
  validateReproFails,
  runReproTest,
  writeReproTest,
  cleanReproTest,
  buildReproInterface,
  parseReproTest,
  REPRO_DIR,
} from './reproduce.js';
export type { ReproTest, ReproResult, ReproContext } from './reproduce.js';

export {
  extractPatchDiff,
  formatForSubmission,
  getDiffFromBase,
  isDiffEmpty,
  summarizePatch,
} from './patch-diff.js';
export type { PatchDiff } from './patch-diff.js';

export {
  initialRepairState,
  runRepairChecks,
  buildFailureMessage,
  buildSuccessMessage,
  shouldContinue,
  determineOutcome,
  renderRepairState,
} from './repair-loop.js';
export type { RepairState, RepairLoopConfig, RepairOutcome } from './repair-loop.js';

import type { SweBenchConfig } from '../config/sections/swe-bench.js';
import type { OmnexxConfig } from '../config/schema.js';

/**
 * Check if the SWE-bench preset is enabled in the config.
 */
export function isSweBenchEnabled(config: OmnexxConfig): boolean {
  return config.sweBench.enabled;
}

/**
 * Get the SWE-bench config with defaults applied.
 */
export function getSweBenchConfig(config: OmnexxConfig): SweBenchConfig {
  return config.sweBench;
}

/**
 * Apply SWE-bench preset overrides to the main config.
 *
 * When `[swe-bench] enabled = true`:
 * - Disables beyond mode (fix the issue, nothing more)
 * - Enables spec tests for validation
 * - Adjusts planning for single-task fix
 */
export function applySweBenchOverrides(config: OmnexxConfig): OmnexxConfig {
  if (!isSweBenchEnabled(config)) return config;

  const swe = config.sweBench;
  const overrides: Partial<OmnexxConfig> = {};

  if (swe.disable_beyond) {
    overrides.beyond = { ...config.beyond, enabled: false };
  }

  overrides.plan = {
    ...config.plan,
    mode: 'fast',
    loop: 'fast',
    loop_rounds: swe.max_repair_rounds,
  };

  overrides.review = {
    ...config.review,
    spec_tests: 'off',
    audit: true,
    strict_checks: true,
  };

  return { ...config, ...overrides };
}

/**
 * Preset prompt additions for SWE-bench mode.
 */
export const SWE_BENCH_PROMPT_ADDITIONS = `
## SWE-bench Mode

This is an issue-fix task. Your goal is to:
1. Understand the bug from the issue description
2. Locate the faulty code using the provided localization
3. Write a minimal fix that resolves the issue
4. Ensure the reproduction test passes AND existing tests stay green

Do NOT:
- Add features beyond what the issue describes
- Refactor unrelated code
- Change test files unless the issue asks for it
- Break existing functionality

The fix is complete when:
- The reproduction test changes from FAIL to PASS
- All existing tests still pass
`;
