/**
 * Turn-efficiency deduplication: unchanged-file re-read short-circuiting and redundant
 * verification coalescing.
 *
 * Both trackers are small, pure, and testable without a terminal. They are wired into the agent
 * loop (`loop.ts`) so that:
 *  - a `read` of the exact same unchanged file slice returns a tiny `[already in context]`
 *    result instead of re-sending thousands of tokens, counted so friction/bandit telemetry can
 *    see it was a redundant read;
 *  - the exact same read-only test/lint verification command run back-to-back with zero mutating
 *    tools in between short-circuits to "already green" for the current working tree.
 */

/**
 * The canonical identity of a read slice: the path plus the normalized requested range, so a
 * repeat read of the same lines is recognized even when the request object differs in shape.
 */
export function readSliceKey(
  path: string,
  start?: number,
  end?: number,
  anchors?: boolean,
): string {
  const s = start ?? 1;
  const e = end ?? Number.MAX_SAFE_INTEGER;
  return `${path}:${String(s)}-${String(e)}${anchors ? ':a' : ''}`;
}

/**
 * Tracks file slices already read during the current loop. A repeat of the same slice with no
 * mutating tool in between is an unchanged re-read; the cache is invalidated automatically
 * whenever any mutating tool passes.
 */
export class RedundantReadTracker {
  private seen = new Map<string, Set<string>>();
  /** Count of redundant reads detected this loop (feeds friction/bandit telemetry). */
  private redundant = 0;
  /** Total tokens saved this loop by short-circuiting unchanged re-reads. */
  private savedTokens = 0;

  /**
   * Register a read of `sliceKey`. Returns `true` when the exact slice was read before (a
   * redundant read the caller can short-circuit), `false` after recording a new one.
   */
  record(path: string, sliceKey: string): boolean {
    let slices = this.seen.get(path);
    if (!slices) {
      slices = new Set<string>();
      this.seen.set(path, slices);
    }
    if (slices.has(sliceKey)) {
      this.redundant += 1;
      return true;
    }
    slices.add(sliceKey);
    return false;
  }

  /** A redundant read was short-circuited: credit the tokens saved. */
  noteSavedTokens(tokens: number): void {
    this.savedTokens += Math.max(0, tokens);
  }

  /** Invalidate the cache — either one touched path, or everything. */
  invalidate(paths?: readonly string[]): void {
    if (!paths || paths.length === 0) {
      this.seen.clear();
      return;
    }
    for (const p of paths) this.seen.delete(p);
  }

  get redundantReads(): number {
    return this.redundant;
  }

  get tokensSaved(): number {
    return this.savedTokens;
  }

  snapshot(): { redundantReads: number; tokensSaved: number } {
    return { redundantReads: this.redundant, tokensSaved: this.savedTokens };
  }
}

/** A verification command, normalized for identity comparison (whitespace + trivial prefix). */
export function normalizeVerifyCommand(cmd: string): string {
  return cmd
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^((?:npx|bunx|pnpm|yarn)\s+)/, '');
}

/**
 * Short-circuits the exact same read-only verification command when it runs back-to-back with no
 * mutating tool in between. `seq` is the monotonically increasing per-tool sequence from the
 * loop; `mutatingSeq` is the seq of the last mutating tool (0 = none yet).
 */
export class VerificationCoalescer {
  private lastCmd = '';
  private lastSeq = -1;

  /**
   * Decide whether a verification command must actually run. Returns `'skip'` when the same
   * normalized command already ran at the immediately previous tool call with zero mutations
   * since, so the agent synthesizes instead of burning a turn.
   */
  decide(cmd: string, seq: number, mutatingSeq: number): 'run' | 'skip' {
    const n = normalizeVerifyCommand(cmd);
    if (!n) return 'run';
    const sameAsPrevious = n === this.lastCmd && seq === this.lastSeq + 1;
    const noMutationsSince = mutatingSeq < seq;
    if (sameAsPrevious && noMutationsSince) return 'skip';
    this.lastCmd = n;
    this.lastSeq = seq;
    return 'run';
  }

  /** A mutating tool passed: the next identical verification must run for real. */
  invalidate(): void {
    this.lastCmd = '';
    this.lastSeq = -1;
  }
}
