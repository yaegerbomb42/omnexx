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

  it('renders the observe-only disclosure (phase line, caps, cadence, savings) and nothing without data', () => {
    const html = kernelObserveHtml(snapshotFromAllocateEvent(ev));
    expect(html).toContain('class="ko-phase on" aria-current="step">act<');
    expect(html).toContain('github');
    expect(html).toContain('sticky · prefix cached');
    expect(html).toContain('6.5k tok/turn saved');
    // Collapsed by default: a <details> with no open attribute.
    expect(html).toMatch(/^<details class="ko">/);
    expect(html).not.toContain(' open');
    // The bm25 `why` debug text is never rendered; capability names only.
    expect(html).not.toContain('bm25 match for');
    expect(html).not.toContain('ko-why');
    // The KV cache row is gone: Live Stats shows the same numbers already.
    expect(html).not.toContain('80% hit');
    expect(html).not.toContain('KV cache');
    expect(html).not.toMatch(/<(input|button|select)/);
    expect(kernelObserveHtml(null)).toBe('');
  });

  it('hides the Selective mount row when nothing is saved and shows core tools only when empty', () => {
    const noSavings = snapshotFromAllocateEvent({ ...ev, mountSavings: null, why: {} });
    const html = kernelObserveHtml(noSavings);
    expect(html).not.toContain('Selective mount');
    expect(html).toContain('core tools only');
  });
});
