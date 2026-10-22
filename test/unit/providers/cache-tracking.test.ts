import { describe, expect, it } from 'vitest';
import { withCacheTracking, conversationCacheKey } from '../../../src/providers/cache-tracking.js';
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  Usage,
} from '../../../src/providers/types.js';

function makeProvider(usage: Usage, model = 'm', advanceMs = 0): Provider {
  return {
    name: 'test',
    async complete(): Promise<CompletionResponse> {
      if (advanceMs) await new Promise((r) => setTimeout(r, advanceMs));
      return {
        model,
        usage,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
      };
    },
  };
}

const USAGE: Usage = {
  uncached: 100,
  cacheRead: 400,
  cacheWrite5m: 10,
  cacheWrite1h: 0,
  output: 50,
};

describe('cache tracking', () => {
  it('reports every call with its cache numbers', () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const wrapped = withCacheTracking(makeProvider(USAGE), {
      emit: (t, d) => events.push({ type: t, data: d }),
    });
    return wrapped
      .complete({
        system: [{ text: 's', volatile: false }],
        tools: [],
        messages: [],
      } as unknown as CompletionRequest)
      .then(() => {
        const ev = events[0];
        if (!ev) throw new Error('no cache.tracked event');
        expect(ev.type).toBe('cache.tracked');
        expect(ev.data.cacheRead).toBe(400);
        expect(ev.data.uncached).toBe(100);
        expect(ev.data.hitRate).toBeCloseTo(0.8);
        expect(ev.data.output).toBe(50);
        expect(ev.data.cacheable).toBe(false);
        expect(ev.data.prefixHash).toHaveLength(64);
        expect(typeof ev.data.ms).toBe('number');
      });
  });

  it('reports a zero hit rate when there is no prompt', async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const wrapped = withCacheTracking(makeProvider({ ...USAGE, uncached: 0, cacheRead: 0 }), {
      emit: (_t, d) => events.push({ type: _t, data: d }),
    });
    await wrapped.complete({ system: [], tools: [], messages: [] } as unknown as CompletionRequest);
    const ev = events[0];
    if (!ev) throw new Error('no cache.tracked event');
    expect(ev.data.hitRate).toBe(0);
  });

  it('derives a stable conversation cache key', () => {
    const req = { system: [{ text: 's', volatile: false }], tools: [] };
    const a = conversationCacheKey('run-1', req);
    expect(a.startsWith('omnexx-run-1-')).toBe(true);
    expect(conversationCacheKey('run-1', req)).toBe(a);
    // A different run id gives a different key.
    expect(conversationCacheKey('run-2', req)).not.toBe(a);
    // A different stable prefix gives a different key.
    expect(
      conversationCacheKey('run-1', { system: [{ text: 'other', volatile: false }], tools: [] }),
    ).not.toBe(a);
  });

  it('uses a custom clock', async () => {
    let tick = 1000;
    const events: { data: Record<string, unknown> }[] = [];
    const wrapped = withCacheTracking(makeProvider(USAGE, 'm', 0), {
      emit: (_t, d) => events.push({ data: d }),
      // Each call to now advances the clock by 42, so each call measures 42 ms.
      now: () => {
        const v = tick;
        tick += 42;
        return v;
      },
    });
    await wrapped.complete({ system: [], tools: [], messages: [] } as unknown as CompletionRequest);
    const first = events[0];
    if (!first) throw new Error('no cache.tracked event');
    expect(first.data.ms).toBe(42);
    await wrapped.complete({ system: [], tools: [], messages: [] } as unknown as CompletionRequest);
    const second = events[1];
    if (!second) throw new Error('no second cache.tracked event');
    expect(second.data.ms).toBe(42);
    await wrapped.complete({ system: [], tools: [], messages: [] } as unknown as CompletionRequest);
    expect(second.data.ms).toBe(42);
  });
});
