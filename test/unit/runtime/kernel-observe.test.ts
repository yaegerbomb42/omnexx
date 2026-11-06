import { describe, expect, it } from 'vitest';
import { cadenceLabel, snapshotFromAllocateEvent } from '../../../src/runtime/kernel/observe.js';
import { kernelObserveHtml } from '../../../vscode/src/webview/kernelObserve.js';

const ev = {
  type: 'kernel.allocate',
  turn: 3,
  tier: 1,
  phase: 'act',
  taskClass: 'standard',
  cadence: 'stay_sticky',
  reason: 'sticky_progress',
  epoch: 1,
  rank: 'bm25',
  why: {
    'local:mcp:github': 'bm25 match for "open a PR" (task_start)',
    'local:skill:pdf': 'kept (sticky)',
  },
  mountSavings: { catalogTokens: 9000, mountedTokens: 2500 },
  priors: [{ arm: 'feature|local:mcp:github', pulls: 3, mean: 0.9 }],
};

describe('kernel observe snapshot', () => {
  it('builds the snapshot and a cadence label from kernel.allocate', () => {
    const s = snapshotFromAllocateEvent(ev);
    expect(s.phase).toBe('act');
    expect(s.active.map((a) => a.id)).toEqual(['local:mcp:github', 'local:skill:pdf']);
    expect(cadenceLabel(s)).toBe('sticky · prefix cached (sticky progress)');
  });

  it('renders the observe-only card (phase pill, caps, cadence, savings) and nothing without data', () => {
    const html = kernelObserveHtml(snapshotFromAllocateEvent(ev), {
      tokens: { input: 10_000, cacheRead: 8_000, cacheWrite: 1_000, output: 500 },
      usd: 0.05,
      turns: 3,
      toolCalls: 3,
      toolErrors: 0,
      compactions: 0,
    });
    expect(html).toContain('class="ko-phase on" aria-current="step">act<');
    expect(html).toContain('github');
    expect(html).toContain('sticky · prefix cached');
    expect(html).toContain('6.5k tok/turn saved');
    expect(html).toContain('80% hit');
    expect(html).not.toMatch(/<(input|button|select)/);
    expect(kernelObserveHtml(null)).toBe('');
  });
});
