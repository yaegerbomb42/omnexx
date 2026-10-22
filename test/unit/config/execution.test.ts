import { describe, expect, it } from 'vitest';
import {
  EXECUTION_MODES,
  EXECUTION_PRESETS,
  applyExecutionMode,
  isExecutionMode,
} from '../../../src/config/execution.js';
import type { ExecutionMode } from '../../../src/config/execution.js';

const PLAN_KEYS = [
  'mode',
  'kind',
  'fast_attempts',
  'loop',
  'loop_rounds',
  'loop_rethinks',
  'loop_rewinds',
  'loop_flaky_reruns',
  'loop_related_tests',
  'loop_think_turns',
  'speculative_checks',
  'fast_max_goal_chars',
  'helpers',
  'milestones',
  'milestone_cap',
];

describe('execution mode', () => {
  it('exposes exactly the three typed modes', () => {
    expect(EXECUTION_MODES).toEqual(['efficient', 'normal', 'extreme']);
    // Compile-time: the tuple is a valid ExecutionMode list.
    const modes: readonly ExecutionMode[] = EXECUTION_MODES;
    expect(modes).toHaveLength(3);
    for (const mode of modes) expect(isExecutionMode(mode)).toBe(true);
  });

  it("the normal preset is empty, so today's defaults stay byte-identical", () => {
    expect(EXECUTION_PRESETS.normal).toEqual({ plan: {} });
    expect(applyExecutionMode('normal')).toEqual({});
  });

  it('efficient tightens the plan/loop presets', () => {
    expect(applyExecutionMode('efficient')).toEqual({
      plan: {
        mode: 'fast',
        fast_attempts: 1,
        loop_rounds: 4,
        loop_rethinks: 1,
        loop_rewinds: 1,
        loop_flaky_reruns: 1,
        loop_think_turns: 4,
      },
    });
  });

  it('extreme deepens the plan/loop presets', () => {
    expect(applyExecutionMode('extreme')).toEqual({
      plan: {
        fast_attempts: 3,
        loop_rounds: 10,
        loop_rethinks: 4,
        loop_rewinds: 3,
        loop_flaky_reruns: 3,
        loop_think_turns: 16,
        speculative_checks: true,
      },
    });
  });

  it('presets touch only known plan/loop keys', () => {
    for (const mode of EXECUTION_MODES) {
      const layer = applyExecutionMode(mode);
      if (mode === 'normal') {
        expect(layer).toEqual({});
        continue;
      }
      expect(Object.keys(layer)).toEqual(['plan']);
      const planOverrides = layer.plan as Record<string, unknown>;
      for (const key of Object.keys(planOverrides)) {
        expect(PLAN_KEYS).toContain(key);
      }
    }
  });

  it('rejects invalid values', () => {
    expect(isExecutionMode('turbo')).toBe(false);
    expect(isExecutionMode('Normal')).toBe(false);
    expect(isExecutionMode('')).toBe(false);
    expect(isExecutionMode(undefined)).toBe(false);
    expect(isExecutionMode(null)).toBe(false);
    expect(isExecutionMode(42)).toBe(false);
    expect(() => applyExecutionMode('turbo' as unknown as ExecutionMode)).toThrow(TypeError);
  });
});
