import { describe, expect, it } from 'vitest';
import { fakeTool, offlineKernel } from './kernel-test-helpers.js';

describe('bug #24: kernel turn index follows the caller', () => {
  it('uses the caller-provided turn number', async () => {
    const k = offlineKernel();
    const base = { objective: 'x', allTools: [fakeTool('read')], defaultMaxTokens: 1000 };
    expect((await k.planTurn({ ...base, turn: 1 })).turn).toBe(1);
    // A reused kernel (second cycle) restarts at the loop's turn 1, not 2.
    expect((await k.planTurn({ ...base, turn: 1 })).turn).toBe(1);
    expect((await k.planTurn(base)).turn).toBe(2);
  });
});
