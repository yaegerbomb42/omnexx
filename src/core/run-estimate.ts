import { median } from '../tui/latency.js';
import type { RunHistory, RunSample } from './run-history.js';

/**
 * Before a run: how long, how many tokens and how much it will likely take, from the most similar
 * past runs. The method is meant to be explained in one sentence: take past work of the same kind
 * (and the same model and fast/planned path when there are enough of those), pick the few whose
 * goal length, repo size and plan size are closest on a log scale, and report their medians, with
 * the spread between their quartiles as a range when it is wide or the sample is small.
 */

export interface EstimateQuery {
  kind: RunSample['kind'];
  model: string;
  goalChars: number;
  repoFiles: number;
  /** Unknown before planning (a run may still take the fast path). */
  planned?: boolean;
  nodes?: number;
}

export interface Spread {
  mid: number;
  lo: number;
  hi: number;
}

export interface RunEstimate {
  /** How many past runs the estimate rests on. */
  basis: number;
  wallMs: Spread;
  tokens: Spread;
  usd: Spread;
  /** Few samples, or the time spread is wide: show a range. */
  uncertain: boolean;
}

/** Neighbours an estimate uses. */
const NEIGHBOURS = 5;
/** A narrower subset (same model, same path) is used once it has this many samples. */
const MIN_SUBSET = 3;
/** Below this many neighbours the estimate shows a range. */
const CONFIDENT_BASIS = 3;
/** A high/low quartile ratio above this shows a range. */
const WIDE_RATIO = 1.6;

const logGap = (a: number, b: number): number => Math.abs(Math.log((a + 1) / (b + 1)));

function distance(q: EstimateQuery, s: RunSample): number {
  const nodes = q.nodes === undefined ? 0 : logGap(q.nodes, s.nodes);
  return logGap(q.goalChars, s.goalChars) + logGap(q.repoFiles, s.repoFiles) + nodes;
}

/** `pool` narrowed by `keep` when that leaves enough samples, else `pool` unchanged. */
function narrow(pool: RunSample[], keep: (s: RunSample) => boolean): RunSample[] {
  const kept = pool.filter(keep);
  return kept.length >= MIN_SUBSET ? kept : pool;
}

function quartile(sorted: readonly number[], p: number): number {
  return sorted[Math.round((sorted.length - 1) * p)] ?? 0;
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return { mid: median(sorted), lo: quartile(sorted, 0.25), hi: quartile(sorted, 0.75) };
}

/** The estimate for `q` from `history`, or undefined with no past work of its kind. */
export function estimateRun(history: RunHistory, q: EstimateQuery): RunEstimate | undefined {
  const sameKind = history.filter((s) => s.kind === q.kind);
  if (!sameKind.length) return undefined;
  const byModel = narrow(sameKind, (s) => s.model === q.model);
  const pool = q.planned === undefined ? byModel : narrow(byModel, (s) => s.planned === q.planned);
  const nearest = [...pool]
    .map((s) => ({ s, d: distance(q, s) }))
    .sort((a, b) => a.d - b.d || b.s.at - a.s.at)
    .slice(0, NEIGHBOURS)
    .map((x) => x.s);
  const wallMs = spread(nearest.map((s) => s.wallMs));
  return {
    basis: nearest.length,
    wallMs,
    tokens: spread(nearest.map((s) => s.freshTokens + s.cachedTokens)),
    usd: spread(nearest.map((s) => s.usd)),
    uncertain:
      nearest.length < CONFIDENT_BASIS || (wallMs.lo > 0 && wallMs.hi / wallMs.lo > WIDE_RATIO),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "45s", "3 min", "1.5 h": the number without the "~". */
function durationNumber(ms: number): { n: string; unit: string } {
  if (ms < MINUTE) return { n: String(Math.max(1, Math.round(ms / 1000))), unit: 's' };
  if (ms < 90 * MINUTE) return { n: String(Math.max(1, Math.round(ms / MINUTE))), unit: ' min' };
  return { n: (ms / HOUR).toFixed(1).replace(/\.0$/, ''), unit: ' h' };
}

export function fmtDuration(ms: number): string {
  const d = durationNumber(ms);
  return `${d.n}${d.unit}`;
}

function fmtRange(lo: number, hi: number): string {
  const a = durationNumber(lo);
  const b = durationNumber(hi);
  if (a.n === b.n && a.unit === b.unit) return `~${a.n}${a.unit}`;
  return a.unit === b.unit ? `${a.n}–${b.n}${b.unit}` : `${a.n}${a.unit}–${b.n}${b.unit}`;
}

export function fmtTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function fmtUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `~$${usd.toFixed(2)}`;
}

/** "est. ~3 min, ~40k tokens, ~$0.02 (5 similar runs)", a range when uncertain, or "no history yet". */
export function formatEstimate(e: RunEstimate | undefined): string {
  if (!e) return 'no history yet';
  const time = e.uncertain ? fmtRange(e.wallMs.lo, e.wallMs.hi) : `~${fmtDuration(e.wallMs.mid)}`;
  const runs = `${e.basis} similar run${e.basis === 1 ? '' : 's'}`;
  return `est. ${time}, ~${fmtTokenCount(e.tokens.mid)} tokens, ${fmtUsd(e.usd.mid)} (${runs})`;
}

export interface Progress {
  elapsedMs: number;
  /** Plan nodes (or todo items) finished and in total; zero total before planning. */
  done: number;
  total: number;
}

/**
 * Time left, as "~2 min left": the pace so far over the nodes still open, averaged with the
 * estimate's remainder when there is one; before any node is done, the estimate alone.
 */
export function remainingMs(e: RunEstimate | undefined, p: Progress): number | undefined {
  const fromEstimate = e ? e.wallMs.mid - p.elapsedMs : undefined;
  if (p.total > 0 && p.done > 0 && p.done <= p.total) {
    const fromPace = (p.elapsedMs / p.done) * (p.total - p.done);
    return fromEstimate !== undefined && fromEstimate > 0
      ? (fromPace + fromEstimate) / 2
      : fromPace;
  }
  return fromEstimate;
}

export function formatRemaining(e: RunEstimate | undefined, p: Progress): string | undefined {
  const left = remainingMs(e, p);
  if (left === undefined) return undefined;
  if (p.total > 0 && p.done >= p.total) return 'finishing up';
  if (left <= 0) return 'taking longer than usual';
  return `~${fmtDuration(left)} left`;
}
