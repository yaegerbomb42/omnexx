import { describe, expect, it } from 'vitest';
import { flagsToConfig } from '../../../src/cli/commands/run.js';
import { autonomousFocus } from '../../../src/core/supervisor.js';
import { BEYOND_RUBRIC } from '../../../src/agent/planner.js';
import { UsageError } from '../../../src/errors.js';

describe('run --for (autonomous mode)', () => {
  it('turns autonomous mode on with the duration as the time budget', () => {
    const cfg = flagsToConfig({ for: '1h30m' });
    expect(cfg.autonomous).toEqual({ enabled: true });
    expect(cfg.budget).toMatchObject({ max_hours: 1.5 });
    expect(cfg.budget?.max_cycles).toBeGreaterThan(10_000);
  });

  it('accepts days', () => {
    expect(flagsToConfig({ for: '2d' }).budget).toMatchObject({ max_hours: 48 });
  });

  it('rejects a bad duration and --for together with --hours', () => {
    expect(() => flagsToConfig({ for: 'eight hours' })).toThrow(UsageError);
    expect(() => flagsToConfig({ for: '0h' })).toThrow(UsageError);
    expect(() => flagsToConfig({ for: '8h', hours: '2' })).toThrow(/not both/);
  });

  it('leaves autonomous mode off without the flag', () => {
    expect(flagsToConfig({ hours: '2' })).not.toHaveProperty('autonomous');
  });
});

describe('autonomousFocus', () => {
  it('tries the user areas first, then the rubric, and wraps around', () => {
    const extra = ['docs'];
    expect(autonomousFocus(extra, 1)).toBe('docs');
    expect(autonomousFocus(extra, 2)).toBe(BEYOND_RUBRIC[0]);
    expect(autonomousFocus(extra, BEYOND_RUBRIC.length + 2)).toBe('docs');
  });
});

describe('per-task budget flags', () => {
  it('maps --task-budget and --task-tokens onto [budget]', () => {
    expect(flagsToConfig({ taskBudget: '0.5', taskTokens: '25000' }).budget).toMatchObject({
      task_max_usd: 0.5,
      task_max_tokens: 25_000,
    });
    expect(flagsToConfig({})).not.toHaveProperty('budget');
  });

  it('rejects non-positive task caps', () => {
    expect(() => flagsToConfig({ taskBudget: '0' })).toThrow(UsageError);
    expect(() => flagsToConfig({ taskTokens: '-1' })).toThrow(UsageError);
  });
});

describe('planning flags', () => {
  it('maps --plan, --plan-helpers and --plan-milestones onto [plan]', () => {
    expect(flagsToConfig({ plan: 'full', planHelpers: '0', planMilestones: '6' })).toMatchObject({
      plan: { mode: 'full', helpers: 0, milestones: 6 },
    });
    expect(flagsToConfig({})).not.toHaveProperty('plan');
  });

  it.each([
    [{ plan: 'deep' }, /--plan is one of auto, fast, full/],
    [{ planHelpers: '9' }, /--plan-helpers expects a whole number from 0 to 8/],
    [{ planMilestones: '0' }, /--plan-milestones expects a whole number from 1 to 30/],
    [{ planMilestones: '2.5' }, /--plan-milestones/],
  ])('rejects %j', (flags, message) => {
    expect(() => flagsToConfig(flags)).toThrow(UsageError);
    expect(() => flagsToConfig(flags)).toThrow(message);
  });
});

describe('run --beyond', () => {
  it('maps --beyond onto [beyond]', () => {
    expect(flagsToConfig({ beyond: '2' })).toMatchObject({ beyond: { max_rounds: 2 } });
    expect(flagsToConfig({ beyond: '0' })).toMatchObject({ beyond: { max_rounds: 0 } });
    expect(flagsToConfig({})).not.toHaveProperty('beyond');
  });

  it.each([
    [{ beyond: '-1' }, /--beyond expects a whole number from 0 to 20/],
    [{ beyond: '21' }, /--beyond expects a whole number from 0 to 20/],
    [{ beyond: '2.5' }, /--beyond expects a whole number from 0 to 20/],
    [{ beyond: 'soon' }, /--beyond expects a whole number from 0 to 20/],
  ])('rejects %j', (flags, message) => {
    expect(() => flagsToConfig(flags)).toThrow(UsageError);
    expect(() => flagsToConfig(flags)).toThrow(message);
  });
});
