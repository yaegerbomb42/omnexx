/**
 * Doom-loop circuit breaker for the think-first loop.
 *
 * After every execute pass the loop records a state node: the checked tree, which checks failed,
 * the individual failing tests (where a parser names them), and the diff size. Nodes are scored
 * (passing tests, then fewer failing checks, then a smaller diff). The breaker trips when two
 * passes in a row lower the score, or when a pass lands on a failure set seen before but not just
 * now (oscillation: fixing A breaks B, fixing B breaks A). The loop then rewinds the tree to the
 * best node, replaces the turns since with a short tombstone and re-thinks.
 */

/** What one check measured, for scoring (all optional parts default to zero / empty). */
export interface PassState {
  /** Tests that passed, summed over gates whose parser counts them. */
  passed: number;
  /** Checks (gates, anti-cheat rules, task checks) that failed. */
  failingChecks: number;
  /** Ids of individual failures (tests, diagnostics): the "bitvector" of what is red. */
  failIds: readonly string[];
  /** Diagnostics (type/lint errors) among the failures. */
  diagnostics: number;
  /** Changed lines in the diff against the cycle's start. */
  diffSize: number;
}

export interface StateNode extends PassState {
  tree: string;
  pass: boolean;
  /** Conversation length right after the pass that produced this node. */
  messageCount: number;
  /** Agent's summary of that pass (what it tried), for the tombstone. */
  summary: string;
  /** Sorted, joined failure ids: equal keys mean the same set of things is red. */
  key: string;
}

export type TripReason = 'score-drop' | 'oscillation';

export interface Trip {
  reason: TripReason;
  best: StateNode;
  /** Nodes after the best one: what was tried since. */
  since: readonly StateNode[];
}

/** Consecutive score drops that trip the breaker. */
export const DROPS_TO_TRIP = 2;
/** Upper bound on the tombstone, in characters (~150 tokens). */
export const TOMBSTONE_CHARS = 600;

export const failKey = (ids: readonly string[]): string =>
  [...new Set(ids)].sort((a, b) => a.localeCompare(b)).join('\n');

/** Lexicographic score: positive when `a` is better than `b`. */
export function compareScore(a: PassState, b: PassState): number {
  return a.passed - b.passed || b.failingChecks - a.failingChecks || b.diffSize - a.diffSize;
}

/** The best node so far; the earliest wins a tie (less churn to undo). */
export function bestNode(nodes: readonly StateNode[]): StateNode | undefined {
  return nodes.reduce<StateNode | undefined>(
    (best, n) => (!best || compareScore(n, best) > 0 ? n : best),
    undefined,
  );
}

function tripReason(nodes: readonly StateNode[]): TripReason | undefined {
  const cur = nodes.at(-1);
  if (!cur || cur.pass) return undefined;
  // A failure set seen before, but not on the previous pass (an immediate repeat is the loop's
  // existing "same failure twice" re-think): the agent is going in circles.
  if (cur.key && nodes.slice(0, -2).some((n) => !n.pass && n.key === cur.key)) return 'oscillation';
  const tail = nodes.slice(-(DROPS_TO_TRIP + 1));
  if (tail.length < DROPS_TO_TRIP + 1) return undefined;
  const dropping = tail.slice(1).every((n, i) => {
    const prev = tail[i];
    return prev !== undefined && compareScore(n, prev) < 0;
  });
  return dropping ? 'score-drop' : undefined;
}

/** Whether the latest node trips the breaker, and where to rewind to. */
export function checkTrip(nodes: readonly StateNode[]): Trip | undefined {
  const reason = tripReason(nodes);
  if (!reason) return undefined;
  const best = bestNode(nodes);
  if (!best || best === nodes.at(-1)) return undefined;
  return { reason, best, since: nodes.slice(nodes.indexOf(best) + 1) };
}

const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A compact note that replaces the pruned turns: what was tried, what it broke, don't repeat. */
export function tombstone(trip: Trip): string {
  const best = trip.best;
  const bestIds = new Set(best.failIds);
  const broke = [...new Set(trip.since.flatMap((n) => n.failIds))].filter((id) => !bestIds.has(id));
  const why =
    trip.reason === 'oscillation'
      ? 'it went in circles (a failure set came back)'
      : 'the checks got worse twice in a row';
  const tried = trip.since.map((n) => oneLine(n.summary, 90)).filter(Boolean);
  const parts = [
    `[harness] Rewound ${trip.since.length} pass(es) to the best tree so far because ${why}.`,
    tried.length ? `Tried: ${tried.join(' / ')}.` : '',
    broke.length ? `It broke: ${broke.slice(0, 5).join(', ')}.` : '',
    "Don't repeat this approach.",
  ];
  const text = parts.filter(Boolean).join(' ');
  return text.length > TOMBSTONE_CHARS ? `${text.slice(0, TOMBSTONE_CHARS - 1)}…` : text;
}

/** A failed action, fingerprinted by what was run and what came back, so identical failures are recognized. */
export interface ActionFingerprint {
  readonly tool: string;
  readonly args: string;
  readonly result: string;
}

/** What to try instead of doing the same thing again. */
export type TripStrategy = 'different-approach' | 'wider-read' | 'subagent';

/** Strategies tried in order as a fingerprint repeats past the trip threshold. */
export const TRIP_STRATEGIES: readonly TripStrategy[] = [
  'different-approach',
  'wider-read',
  'subagent',
];

/** The identical (tool, args, result) failure twice is a coincidence; the third is a pattern. */
export const REPEAT_TRIP = 3;

/** Average tokens (input + output) one failed action attempt burns; used for waste math. */
export const AVG_ATTEMPT_TOKENS = 1500;

/** A strategy change forced when an action keeps failing identically. */
export interface StrategyChange {
  /** The exact (tool, args, result) fingerprint that kept coming back. */
  readonly fingerprint: string;
  /** How many times the failure has repeated so far. */
  readonly repeats: number;
  /** What the loop should try instead of doing the same thing again. */
  readonly strategy: TripStrategy;
}

const fingerprintOf = (a: ActionFingerprint): string => `${a.tool}\u0000${a.args}\u0000${a.result}`;

/**
 * Ledger of failing-action fingerprints. Detects the identical (tool, args, result) failure
 * repeating and forces a strategy change on the third occurrence, so the loop stops hammering a
 * dead end. The fingerprint is O(1) per record, so it never adds meaningful latency or context.
 */
export class DoomLedger {
  private readonly counts = new Map<string, number>();
  private readonly deadEnd = new Set<string>();

  /** Record a failed action. Returns a strategy change once it has repeated three times. */
  record(action: ActionFingerprint): StrategyChange | undefined {
    const fingerprint = fingerprintOf(action);
    const n = (this.counts.get(fingerprint) ?? 0) + 1;
    this.counts.set(fingerprint, n);
    if (n === REPEAT_TRIP) this.deadEnd.add(fingerprint);
    if (n < REPEAT_TRIP) return undefined;
    const strategy =
      TRIP_STRATEGIES[(n - REPEAT_TRIP) % TRIP_STRATEGIES.length] ?? 'different-approach';
    return { fingerprint, repeats: n, strategy };
  }

  /** How many times this exact failure has been recorded. */
  repeats(action: ActionFingerprint): number {
    return this.counts.get(fingerprintOf(action)) ?? 0;
  }

  /** Fingerprints that hit the trip threshold: confirmed dead ends. */
  get deadEnds(): readonly string[] {
    return [...this.deadEnd].sort((a, b) => a.localeCompare(b));
  }

  /** Attempts a breaker would have spared past its trip thresholds, across all fingerprints. */
  prevented(): number {
    let saved = 0;
    for (const count of this.counts.values()) {
      if (count > REPEAT_TRIP) saved += count - REPEAT_TRIP;
    }
    return saved;
  }
}

/**
 * Tokens the breaker spends on repeated failing attempts: each fingerprint is paid for up to the
 * trip threshold, after which a change is forced.
 */
export function repeatedTokens(actions: readonly ActionFingerprint[]): number {
  const counts = new Map<string, number>();
  let tokens = 0;
  for (const action of actions) {
    const fingerprint = fingerprintOf(action);
    const n = (counts.get(fingerprint) ?? 0) + 1;
    counts.set(fingerprint, n);
    if (n <= REPEAT_TRIP) tokens += AVG_ATTEMPT_TOKENS;
  }
  return tokens;
}

/** Tokens spent on all attempts without any breaker (the raw waste). */
export function baselineTokens(actions: readonly ActionFingerprint[]): number {
  return actions.length * AVG_ATTEMPT_TOKENS;
}
