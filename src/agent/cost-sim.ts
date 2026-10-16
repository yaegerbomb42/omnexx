/**
 * A token and cost simulator for context policies: replays a synthetic trajectory turn by turn
 * against a provider that caches the longest unchanged prompt prefix (cache reads ~10% of the
 * input price, writes ~125%). It models what the real compaction does at block level: pruning
 * rewrites a block in place (everything after it misses the cache once), a fold replaces all but
 * the last K turns with a working-state block, and the budget guard digests the largest blocks.
 * Used by tests to pick thresholds that don't cost more than the policy they replace.
 */

export interface SimPrice {
  /** USD per million tokens. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface SimTurn {
  /** Tokens the assistant writes (text + tool call). */
  output: number;
  /** Tokens of the tool result the turn gets back. */
  result: number;
  /** A later turn that makes this result dead weight (re-read, edit, passed command). */
  supersededAt?: number;
}

export interface SimPolicy {
  name: string;
  budget: number;
  /** Fold at this fraction of the budget. */
  foldFraction: number;
  /** Clear old results past this fraction of the budget (0 = never). */
  clearFraction: number;
  keepTurns: number;
  keepResults: number;
  /** Prune superseded results as soon as this many tokens would go (Infinity = only past clear). */
  pruneMinTokens: number;
  /** Working-state block size after a fold, and its growth per folded turn. */
  stateBase: number;
  statePerTurn: number;
  stateMax: number;
  /** After a fold, digest the largest kept blocks (not the newest turn) down to this share. */
  settleFraction?: number;
}

export interface SimResult {
  usd: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  folds: number;
  prunes: number;
  maxContext: number;
}

interface Block {
  /** Changes whenever the block is rewritten, so the cache sees a different prefix. */
  id: string;
  tokens: number;
  turn: number;
  result: boolean;
  supersededAt?: number;
  stubbed?: boolean;
}

const STUB_TOKENS = 30;
const DIGEST_TOKENS = 150;
const FOLD_OUTPUT_TOKENS = 1_200;
const M = 1_000_000;

const total = (blocks: readonly Block[]): number => blocks.reduce((a, b) => a + b.tokens, 0);

/** Tokens of the longest prefix `next` shares with `prev`. */
function sharedPrefix(prev: readonly Block[], next: readonly Block[]): number {
  let n = 0;
  for (let i = 0; i < Math.min(prev.length, next.length); i++) {
    if (prev[i]?.id !== next[i]?.id) break;
    n += next[i]?.tokens ?? 0;
  }
  return n;
}

const stub = (b: Block, tag: string): Block => ({
  ...b,
  id: `${b.id}~${tag}`,
  tokens: STUB_TOKENS,
  stubbed: true,
});

function prune(blocks: Block[], turn: number, p: SimPolicy, force: boolean): Block[] | undefined {
  const dead = blocks.filter((b) => b.result && !b.stubbed && (b.supersededAt ?? Infinity) <= turn);
  const saved = dead.reduce((a, b) => a + b.tokens - STUB_TOKENS, 0);
  if (!dead.length || (!force && saved < p.pruneMinTokens)) return undefined;
  const ids = new Set(dead.map((b) => b.id));
  return blocks.map((b) => (ids.has(b.id) ? stub(b, 'p') : b));
}

function clear(blocks: Block[], p: SimPolicy): Block[] {
  const results = blocks.filter((b) => b.result && !b.stubbed);
  const old = new Set(
    results.slice(0, Math.max(0, results.length - p.keepResults)).map((b) => b.id),
  );
  return blocks.map((b) => (old.has(b.id) && b.tokens > STUB_TOKENS * 4 ? stub(b, 'c') : b));
}

function guard(blocks: Block[], budget: number, protect = 0): Block[] {
  let out = blocks;
  const big = [...blocks.slice(1, blocks.length - protect)].sort((a, b) => b.tokens - a.tokens);
  for (const b of big) {
    if (total(out) <= budget) break;
    if (b.tokens <= DIGEST_TOKENS) break;
    out = out.map((x) => (x.id === b.id ? { ...x, id: `${x.id}~d`, tokens: DIGEST_TOKENS } : x));
  }
  return out;
}

/** Replay `turns` under `policy`; `system` is the stable prefix (system prompt + tools + goal). */
export function simulate(
  turns: readonly SimTurn[],
  policy: SimPolicy,
  system: number,
  price: SimPrice,
  foldPrice: SimPrice,
): SimResult {
  let blocks: Block[] = [{ id: 'sys', tokens: system, turn: -1, result: false }];
  let prev: Block[] = [];
  const r: SimResult = {
    usd: 0,
    inputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    folds: 0,
    prunes: 0,
    maxContext: 0,
  };
  let foldedTurns = 0;
  let stateVersion = 0;
  turns.forEach((t, turn) => {
    const pastClear =
      policy.clearFraction > 0 && total(blocks) > policy.budget * policy.clearFraction;
    const pruned = prune(blocks, turn, policy, pastClear);
    if (pruned) {
      blocks = pruned;
      r.prunes++;
    }
    if (policy.clearFraction > 0 && total(blocks) > policy.budget * policy.clearFraction)
      blocks = clear(blocks, policy);
    if (total(blocks) > policy.budget * policy.foldFraction) {
      const cut = turn - policy.keepTurns;
      const head = blocks.filter((b) => b.turn >= 0 && b.turn < cut);
      if (head.length) {
        foldedTurns += new Set(head.map((b) => b.turn)).size;
        const state = Math.min(
          policy.stateMax,
          policy.stateBase + policy.statePerTurn * foldedTurns,
        );
        const foldIn = total(head) + (stateVersion ? state : 0);
        r.usd += (foldIn * foldPrice.input + FOLD_OUTPUT_TOKENS * foldPrice.output) / M;
        stateVersion++;
        blocks = [
          blocks[0] as Block,
          { id: `state${stateVersion}`, tokens: state, turn: -1, result: false },
          ...blocks.filter((b) => b.turn >= cut),
        ];
        // The fold rewrites everything after the state anyway: shrinking the kept tail now
        // costs no extra cache miss and keeps the next fold far away.
        if (policy.settleFraction) blocks = guard(blocks, policy.budget * policy.settleFraction, 2);
        r.folds++;
      }
    }
    blocks = guard(blocks, policy.budget);
    const size = total(blocks);
    const cached = sharedPrefix(prev, blocks);
    r.inputTokens += size;
    r.cacheRead += cached;
    r.cacheWrite += size - cached;
    r.maxContext = Math.max(r.maxContext, size);
    r.usd +=
      (cached * price.cacheRead + (size - cached) * price.cacheWrite + t.output * price.output) / M;
    prev = blocks;
    blocks = [
      ...blocks,
      { id: `a${turn}`, tokens: t.output, turn, result: false },
      {
        id: `r${turn}`,
        tokens: t.result,
        turn,
        result: true,
        ...(t.supersededAt === undefined ? {} : { supersededAt: t.supersededAt }),
      },
    ];
  });
  return r;
}

/** A deterministic pseudo-random trajectory (mulberry32), shaped like a real coding session. */
export function syntheticTrajectory(seed: number, n: number, supersededShare = 0.4): SimTurn[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: n }, (_, i) => {
    const big = rand() < 0.15;
    const result = Math.round(big ? 6_000 + rand() * 14_000 : 300 + rand() * 2_500);
    const later = rand() < supersededShare ? i + 1 + Math.floor(rand() * 8) : undefined;
    return {
      output: Math.round(150 + rand() * 600),
      result,
      ...(later === undefined ? {} : { supersededAt: later }),
    };
  });
}
