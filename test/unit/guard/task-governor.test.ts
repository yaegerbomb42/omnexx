import { describe, expect, it } from 'vitest';
import type { PriceConfig } from '../../../src/config/schema.js';
import { TaskGovernor } from '../../../src/guard/task-governor.js';

const price: PriceConfig = {
  id: 'test',
  input: 1,
  output: 1,
  cache_write_5m: 1,
  cache_write_1h: 1,
  cache_read: 0,
};

const tokens = (g: TaskGovernor, prompt: number, output = 0) =>
  g.check({ taskId: 'M1.T01', promptTokens: prompt, maxOutputTokens: output, price });

describe('TaskGovernor', () => {
  it('is a no-op without caps', () => {
    const g = new TaskGovernor({ warnAt: 0.8 });
    expect(g.enabled).toBe(false);
    expect(tokens(g, 10_000_000).allowed).toBe(true);
  });

  it('warns once at 80% of the token cap and blocks before 100%', () => {
    const g = new TaskGovernor({ maxTokens: 1_000, maxUsd: undefined, warnAt: 0.8 });
    expect(tokens(g, 700).warning).toBeUndefined();
    const observed = g.observe({ taskId: 'M1.T01', tokens: 850, usd: 0 });
    expect(observed.warning).toMatchObject({ cap: 'tokens' });
    expect(observed.snapshot.fraction).toBeCloseTo(0.85);
    // A second crossing is silent.
    expect(g.observe({ taskId: 'M1.T01', tokens: 10, usd: 0 }).warning).toBeUndefined();
    const blocked = tokens(g, 200);
    expect(blocked).toMatchObject({ allowed: false, kind: 'task_max_tokens' });
    expect(blocked.detail).toContain('would reach 1060 tokens');
  });

  it('blocks a call whose worst-case price would cross the dollar cap', () => {
    const g = new TaskGovernor({ maxTokens: undefined, maxUsd: 0.002, warnAt: 0.8 });
    // 1,000 input + 1,001 output at $1/M is just over $0.002.
    const blocked = tokens(g, 1_000, 1_001);
    expect(blocked).toMatchObject({ allowed: false, kind: 'task_max_usd' });
    expect(blocked.detail).toContain('cap $0.002');
  });

  it('resets spend when the task changes', () => {
    const g = new TaskGovernor({ maxTokens: 1_000, maxUsd: undefined, warnAt: 0.8 });
    g.observe({ taskId: 'M1.T01', tokens: 900, usd: 0 });
    expect(g.snapshot().tokens).toBe(900);
    g.begin('M1.T02');
    expect(g.snapshot().tokens).toBe(0);
    expect(tokens(g, 900)).toMatchObject({ allowed: true });
  });

  it('reports the tightest cap as the fraction', () => {
    const g = new TaskGovernor({ maxTokens: 10_000, maxUsd: 1, warnAt: 0.8 });
    g.observe({ taskId: 'M1.T01', tokens: 5_000, usd: 0.25 });
    expect(g.snapshot()).toMatchObject({ tokens: 5_000, usd: 0.25 });
    expect(g.snapshot().fraction).toBeCloseTo(0.5);
  });
});
