import { describe, expect, it } from 'vitest';
import type { TurnAllocation } from '../../../src/runtime/kernel/types.js';
import { fakeTool, offlineKernel } from './kernel-test-helpers.js';

function forceTier3(k: ReturnType<typeof offlineKernel>, mountedTools: string[]): void {
  const alloc: TurnAllocation = {
    tier: 3,
    reasoningMode: 'cot',
    activeRoles: ['executor'],
    mountedTools,
    mountedSkills: [],
    maxTokensTurn: 4000,
    allowCodeModeBatching: false,
    blastRadius: 'low',
  };
  (k as unknown as { router: { allocate: () => Promise<TurnAllocation> } }).router.allocate = () =>
    Promise.resolve(alloc);
}

const tools = ['read', 'multi_edit', 'apply_patch', 'mcp__acme__edit', 'deploy'].map((n) =>
  fakeTool(n),
);

describe('bug #6: tier>=2 filter keeps editing tools', () => {
  it('keeps multi_edit / apply_patch even when the router mounts a small set', async () => {
    const k = offlineKernel();
    forceTier3(k, ['read']);
    const plan = await k.planTurn({ objective: 'edit', allTools: tools, defaultMaxTokens: 1000 });
    const names = plan.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read', 'multi_edit', 'apply_patch']));
    expect(names).not.toContain('deploy');
  });

  it('honors configured essentialTools', async () => {
    const k = offlineKernel({ essentialTools: ['mcp__acme__edit'] });
    forceTier3(k, ['read']);
    const plan = await k.planTurn({ objective: 'edit', allTools: tools, defaultMaxTokens: 1000 });
    expect(plan.tools.map((t) => t.name)).toContain('mcp__acme__edit');
  });
});
