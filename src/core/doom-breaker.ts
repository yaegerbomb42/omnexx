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

export const failKey = (ids: readonly string[]): string => [...new Set(ids)].sort().join('\n');

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
