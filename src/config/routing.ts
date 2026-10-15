/**
 * How a role uses its ranked models. The three modes people choose:
 * - random: any model in the list on each call, spreading load and quota.
 * - priority: #1 first on every call; on an error the next one takes that call only.
 * - fallback: stick with #1 until it is out of quota or rate-limited (per the quota ledger), then
 *   #2, and so on; #1 is used again once its mark expires.
 * Two internal ones stay for helpers and old settings: least-busy (providers with the fewest
 * helpers running go first) and smart (priciest output first, as a stand-in for capability).
 * Every strategy keeps every model as a fallback for the call.
 */
export const STRATEGIES = ['fallback', 'priority', 'random', 'least-busy', 'smart'] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** The modes shown in the editor and /models, in display order. */
export const MAIN_STRATEGIES = ['random', 'priority', 'fallback'] as const;
export type MainStrategy = (typeof MAIN_STRATEGIES)[number];

export const STRATEGY_LABEL: Record<Strategy, string> = {
  random: 'Random',
  priority: 'Rank priority',
  fallback: 'Fallback on quota',
  'least-busy': 'Least busy',
  smart: 'Smart',
};

export const STRATEGY_HINT: Record<Strategy, string> = {
  random: 'pick any model in the list each call (spreads load and quota)',
  priority: 'always try #1 first each call; on an error use the next one for that call',
  fallback:
    'stick with #1 until it runs out of quota or is rate-limited, then #2 until #1 recovers',
  'least-busy': 'start on the provider with the fewest helpers running',
  smart: 'most capable (priciest) model first',
};

/** A plain 429 (not an empty quota) keeps a fallback list off that model this long. */
export const RATE_LIMITED_FOR_MS = 5 * 60_000;

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

function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  return xs
    .map((m) => ({ m, k: rnd() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.m);
}

export function orderForStrategy<T extends Routable>(
  chain: readonly T[],
  strategy: Strategy,
  ctx: OrderContext = {},
): T[] {
  const indexed = chain.map((m, i) => ({ m, i }));
  switch (strategy) {
    case 'random':
      return shuffle(chain, ctx.random ?? Math.random);
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

/** The order to try the chain in for one call: random reshuffles every call, the rest keep it. */
export function callOrder<T>(
  chain: readonly T[],
  strategy: Strategy | undefined,
  random: () => number = Math.random,
): T[] {
  return strategy === 'random' ? shuffle(chain, random) : [...chain];
}

/** Whether a call skips models the quota ledger marks as out (priority always tries #1). */
export const skipsOutModels = (strategy: Strategy | undefined): boolean => strategy !== 'priority';

/** Whether a plain rate limit moves the list off a model for a while (fallback only). */
export const sticksOnRateLimit = (strategy: Strategy | undefined): boolean =>
  strategy === 'fallback';

/** The strategy a role uses: its setting, else least-busy for helpers (when spreading), else fallback. */
export function strategyFor(
  models: { routing?: Partial<Record<string, Strategy>>; spread_helpers?: boolean },
  role: string,
): Strategy {
  const set = models.routing?.[role];
  if (set) return set;
  return role === 'helpers' && models.spread_helpers !== false ? 'least-busy' : 'fallback';
}

/** Old settings called "stay on #1 until its quota runs out" priority (or ordered, in /models). */
export function migrateStrategy(value: unknown, legacy: boolean): Strategy | undefined {
  if (value === 'ordered') return 'fallback';
  if (typeof value !== 'string' || !(STRATEGIES as readonly string[]).includes(value))
    return undefined;
  return legacy && value === 'priority' ? 'fallback' : (value as Strategy);
}
