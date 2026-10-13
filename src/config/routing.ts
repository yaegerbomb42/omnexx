/**
 * How a role's models are ordered before each use. The first model is tried first; the rest are
 * the failover chain, so every strategy keeps every model as a fallback.
 * - priority: as the person arranged them.
 * - random: a fresh shuffle each time, spreading load evenly.
 * - least-busy: providers with the fewest helpers running go first (parallel helpers spread out).
 * - smart: the most capable first, with output price as the stand-in for capability.
 */
export const STRATEGIES = ['priority', 'random', 'least-busy', 'smart'] as const;
export type Strategy = (typeof STRATEGIES)[number];

interface Routable {
  provider: string;
  price?: { output?: number } | undefined;
}

export interface OrderContext {
  /** Helpers running per provider right now (least-busy). */
  busy?: ReadonlyMap<string, number>;
  /** Source of randomness (tests pass a fixed one). */
  random?: () => number;
}

export function orderForStrategy<T extends Routable>(
  chain: readonly T[],
  strategy: Strategy,
  ctx: OrderContext = {},
): T[] {
  const indexed = chain.map((m, i) => ({ m, i }));
  switch (strategy) {
    case 'random': {
      const rnd = ctx.random ?? Math.random;
      const keys = new Map(indexed.map((x) => [x.i, rnd()]));
      return indexed.sort((a, b) => (keys.get(a.i) ?? 0) - (keys.get(b.i) ?? 0)).map((x) => x.m);
    }
    case 'least-busy': {
      const busy = ctx.busy ?? new Map<string, number>();
      return indexed
        .sort((a, b) => (busy.get(a.m.provider) ?? 0) - (busy.get(b.m.provider) ?? 0) || a.i - b.i)
        .map((x) => x.m);
    }
    case 'smart':
      return indexed
        .sort((a, b) => (b.m.price?.output ?? 0) - (a.m.price?.output ?? 0) || a.i - b.i)
        .map((x) => x.m);
    default:
      return [...chain];
  }
}

/** The strategy a role uses: its setting, else least-busy for helpers (when spreading) and priority. */
export function strategyFor(
  models: { routing?: Partial<Record<string, Strategy>>; spread_helpers?: boolean },
  role: string,
): Strategy {
  const set = models.routing?.[role];
  if (set) return set;
  return role === 'helpers' && models.spread_helpers !== false ? 'least-busy' : 'priority';
}
