import type { z } from 'zod';
import type { plan } from './sections/plan.js';

/**
 * Execution modes are a single knob for how hard the agent tries per task. Each mode maps to
 * a plan/loop preset that fills in keys the user did not set explicitly; anything set anywhere
 * (flags, env, project, user, agent settings) still wins. "normal" adds nothing and keeps
 * today's defaults byte-identical.
 */
export type ExecutionMode = 'efficient' | 'normal' | 'extreme';

export const EXECUTION_MODES = ['efficient', 'normal', 'extreme'] as const;

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);
}

/** The plan/loop overrides a mode applies. Only keys present here are ever touched. */
export interface ExecutionPreset {
  plan: Partial<z.infer<typeof plan>>;
}

export const EXECUTION_PRESETS: Readonly<Record<ExecutionMode, ExecutionPreset>> = {
  // Byte-identical to today's defaults: no overrides at all.
  normal: { plan: {} },
  // Cheaper and faster: always try the fast path first, fewer rounds, less rethinking.
  efficient: {
    plan: {
      mode: 'fast',
      fast_attempts: 1,
      loop_rounds: 4,
      loop_rethinks: 1,
      loop_rewinds: 1,
      loop_flaky_reruns: 1,
      loop_think_turns: 4,
    },
  },
  // Deeper: more fast-path attempts, many more rounds, thinking, rethinks and rewinds.
  extreme: {
    plan: {
      fast_attempts: 3,
      loop_rounds: 10,
      loop_rethinks: 4,
      loop_rewinds: 3,
      loop_flaky_reruns: 3,
      loop_think_turns: 16,
      speculative_checks: true,
    },
  },
};

/**
 * The layer data a mode contributes to the merged config. Returns an empty object for "normal",
 * so applying it never changes a single key.
 */
export function applyExecutionMode(mode: ExecutionMode): Record<string, unknown> {
  if (!isExecutionMode(mode)) throw new TypeError(`unknown execution mode: ${String(mode)}`);
  // "normal" is the identity: it contributes no layer at all.
  if (mode === 'normal') return {};
  return EXECUTION_PRESETS[mode] as unknown as Record<string, unknown>;
}
