import { describe, expect, it } from 'vitest';
import type { TurnAllocation } from '../../../src/runtime/kernel/types.js';
import { fakeTool, offlineKernel } from './kernel-test-helpers.js';

describe('bug #11: MCTS never downgrades a tier-3 seed', () => {
  it('keeps tier 3 when the seed is tier 3 + mcts', async () => {
    const k = offlineKernel();
    const alloc: TurnAllocation = {
      tier: 3,
      reasoningMode: 'mcts',
      mctsBranchFactor: 3,
      activeRoles: ['executor'],
      mountedTools: ['read'],
      mountedSkills: [],
      maxTokensTurn: 4000,
      allowCodeModeBatching: false,
      blastRadius: 'low',
    };
    (k as unknown as { router: { allocate: () => Promise<TurnAllocation> } }).router.allocate =
      () => Promise.resolve(alloc);
    const plan = await k.planTurn({
      objective: 'x',
      allTools: [fakeTool('read')],
      defaultMaxTokens: 1000,
    });
    expect(plan.allocation.reasoningMode).toBe('mcts');
    expect(plan.allocation.tier).toBe(3);
  });
});
