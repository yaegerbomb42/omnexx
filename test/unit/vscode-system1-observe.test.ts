import { describe, expect, it } from 'vitest';
import {
  emptySystemOneSnapshot,
  reduceSystemOneEvent,
} from '../../src/runtime/system-one/observe.js';
import {
  kernelObserveHtml,
  systemOneObserveHtml,
  type KernelSnapshot,
} from '../../vscode/src/webview/kernelObserve.js';

const kernel: KernelSnapshot = {
  turn: 2,
  phase: 'act',
  taskClass: 'standard',
  tier: 1,
  cadence: 'stay_sticky',
  reason: 'sticky_progress',
  epoch: 1,
  rank: 'bm25',
  active: [],
  mountSavings: null,
  priors: [],
};

describe('System-1 observe card', () => {
  const snap = [
    { type: 'system1.backend', label: 'Jev (jev-latest)', model: 'jev-latest' },
    {
      type: 'system1.intent',
      intent: 'explain_code',
      confidence: 0.92,
      speculated: true,
      tokensSaved: 4000,
      p50Ms: 0.4,
    },
    { type: 'system1.guardrail', blocked: true, prompted: false },
    { type: 'system1.guardrail', blocked: false, prompted: false },
    { type: 'system1.patch_sanity', rejected: true },
    { type: 'system1.triage', linesPruned: 380, tokensSaved: 3100 },
    { type: 'system1.early_stop', tokensSaved: 4000 },
    { type: 'kernel.allocate' },
  ].reduce(reduceSystemOneEvent, emptySystemOneSnapshot());

  it('folds events into backend, last intent, gate counts, and savings', () => {
    expect(snap.backend).toBe('Jev (jev-latest)');
    expect(snap.intent).toEqual({ label: 'explain_code', confidence: 0.92 });
    expect(snap.guardrail).toEqual({ checked: 2, intercepted: 1 });
    expect(snap.patch).toEqual({ checked: 1, caught: 1 });
    expect(snap.tokensSaved).toBe(11_100);
    expect(snap.earlyStop.turnsSaved).toBe(1);
  });

  it('renders an observe-only card with escaped text and no controls', () => {
    const html = systemOneObserveHtml({ ...snap, backend: '<script>x</script>' });
    expect(html).toContain('System-1');
    expect(html).toContain('explain code · 92%');
    expect(html).toContain('2 checked · 1 intercepted');
    expect(html).toContain('1 checked · 1 caught');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<(button|input|select)|data-action/);
  });

  it('rides under the Kernel card, or stands alone when the kernel is off', () => {
    expect(kernelObserveHtml(kernel, null, snap)).toMatch(
      /aria-label="Kernel"[\s\S]*aria-label="System-1"/,
    );
    expect(kernelObserveHtml(null, null, snap)).toContain('aria-label="System-1"');
    expect(kernelObserveHtml(null, null, null)).toBe('');
    expect(kernelObserveHtml(kernel, null)).not.toContain('System-1');
  });
});
