import { describe, expect, it } from 'vitest';
import { fakeTool, offlineKernel } from './kernel-test-helpers.js';

describe('bug #10: multi-sample divergence does not bleed into the same turn', () => {
  it('applies divergence after the plan snapshot', async () => {
    const k = offlineKernel();
    const tel = (
      k as unknown as { telemetry: { observeDivergence: (s: readonly number[]) => void } }
    ).telemetry;
    const order: string[] = [];
    const orig = tel.observeDivergence.bind(tel);
    tel.observeDivergence = (s) => {
      order.push('divergence');
      orig(s);
    };
    const snap = (tel as unknown as { snapshot: () => unknown }).snapshot.bind(tel);
    (tel as unknown as { snapshot: () => unknown }).snapshot = () => {
      order.push('snapshot');
      return snap();
    };
    await k.planTurn({
      objective: 'refactor the parser and run tests',
      allTools: ['read', 'bash', 'write_file'].map((n) => fakeTool(n)),
      defaultMaxTokens: 1000,
    });
    const i = order.indexOf('divergence');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(order.slice(i + 1)).not.toContain('snapshot');
  });
});
