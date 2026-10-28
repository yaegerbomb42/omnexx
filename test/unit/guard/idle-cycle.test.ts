import { describe, expect, it } from 'vitest';
import { isIdleCycle } from '../../../src/guard/stuck.js';

const base = {
  verdict: 'reject' as const,
  diffFiles: 0,
  budgetCut: false,
  checksFailed: false,
};

describe('isIdleCycle', () => {
  it('a rejected cycle with no diff and no failing check is idle', () => {
    expect(isIdleCycle(base)).toBe(true);
  });

  it('a cycle with a diff attempted real work, even when rejected', () => {
    expect(isIdleCycle({ ...base, diffFiles: 3 })).toBe(false);
  });

  it('an accepted cycle is progress, with or without a diff', () => {
    expect(isIdleCycle({ ...base, verdict: 'accept' })).toBe(false);
    expect(isIdleCycle({ ...base, verdict: 'accept', diffFiles: 2 })).toBe(false);
  });

  it('a budget-cut cycle is an interruption, not idleness', () => {
    expect(isIdleCycle({ ...base, budgetCut: true })).toBe(false);
  });

  it('a failing task check is new information, not idleness', () => {
    expect(isIdleCycle({ ...base, checksFailed: true })).toBe(false);
  });
});
