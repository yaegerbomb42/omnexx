import { describe, expect, it } from 'vitest';
import { orderForStrategy, strategyFor } from '../../../src/config/routing.js';

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
  it('uses the setting, else least-busy for helpers while spreading, else priority', () => {
    expect(strategyFor({ routing: { worker: 'random' } }, 'worker')).toBe('random');
    expect(strategyFor({}, 'helpers')).toBe('least-busy');
    expect(strategyFor({ spread_helpers: false }, 'helpers')).toBe('priority');
    expect(strategyFor({}, 'planner')).toBe('priority');
  });
});
