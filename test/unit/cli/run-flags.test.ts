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
