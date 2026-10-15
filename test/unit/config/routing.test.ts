import { describe, expect, it } from 'vitest';
import {
  callOrder,
  migrateStrategy,
  orderForStrategy,
  skipsOutModels,
  sticksOnRateLimit,
  strategyFor,
} from '../../../src/config/routing.js';

const m = (provider: string, output = 0) => ({ provider, ref: `${provider}:x`, price: { output } });
const chain = [m('groq', 1), m('cerebras', 10), m('ollama', 0), m('openrouter', 5)];
const providers = (xs: { provider: string }[]) => xs.map((x) => x.provider);

describe('orderForStrategy', () => {
  it('priority keeps the arranged order', () => {
    expect(providers(orderForStrategy(chain, 'priority'))).toEqual([
      'groq',
      'cerebras',
      'ollama',
      'openrouter',
    ]);
  });

  it('least-busy puts the providers with the fewest running helpers first, ties in order', () => {
    const busy = new Map([
      ['groq', 2],
      ['cerebras', 1],
    ]);
    expect(providers(orderForStrategy(chain, 'least-busy', { busy }))).toEqual([
      'ollama',
      'openrouter',
      'cerebras',
      'groq',
    ]);
  });

  it('smart puts the most capable (priciest output) first; random shuffles but keeps all', () => {
    expect(providers(orderForStrategy(chain, 'smart'))).toEqual([
      'cerebras',
      'openrouter',
      'groq',
      'ollama',
    ]);
    const seq = [0.9, 0.1, 0.5, 0.3];
    let i = 0;
    const shuffled = orderForStrategy(chain, 'random', { random: () => seq[i++] ?? 0 });
    expect(providers(shuffled)).toEqual(['cerebras', 'openrouter', 'ollama', 'groq']);
    expect(new Set(providers(shuffled)).size).toBe(4);
  });
});

describe('strategyFor', () => {
  it('uses the setting, else least-busy for helpers while spreading, else fallback', () => {
    expect(strategyFor({ routing: { worker: 'random' } }, 'worker')).toBe('random');
    expect(strategyFor({}, 'helpers')).toBe('least-busy');
    expect(strategyFor({ spread_helpers: false }, 'helpers')).toBe('fallback');
    expect(strategyFor({}, 'planner')).toBe('fallback');
  });
});

describe('per-call routing', () => {
  it('random reshuffles every call; the other modes keep the ranked order', () => {
    const refs = ['a', 'b', 'c'];
    const seq = [0.9, 0.1, 0.5];
    let i = 0;
    expect(callOrder(refs, 'random', () => seq[i++] ?? 0)).toEqual(['b', 'c', 'a']);
    expect(callOrder(refs, 'priority')).toEqual(refs);
    expect(callOrder(refs, 'fallback')).toEqual(refs);
    expect(callOrder(refs, undefined)).toEqual(refs);
  });

  it('only priority ignores quota marks; only fallback sticks on a rate limit', () => {
    expect(skipsOutModels('priority')).toBe(false);
    expect(skipsOutModels('fallback')).toBe(true);
    expect(skipsOutModels('random')).toBe(true);
    expect(sticksOnRateLimit('fallback')).toBe(true);
    expect(sticksOnRateLimit('priority')).toBe(false);
    expect(sticksOnRateLimit('random')).toBe(false);
  });

  it('migrates old names: ordered and legacy priority become fallback', () => {
    expect(migrateStrategy('ordered', false)).toBe('fallback');
    expect(migrateStrategy('priority', true)).toBe('fallback');
    expect(migrateStrategy('priority', false)).toBe('priority');
    expect(migrateStrategy('smart', true)).toBe('smart');
    expect(migrateStrategy('nope', false)).toBeUndefined();
  });
});
