import { describe, expect, it } from 'vitest';
import {
  emptySystemOneSnapshot,
  reduceSystemOneEvent,
} from '../../src/runtime/system-one/observe.js';

describe('System-1 observe folding', () => {
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
});
