import type { Clock } from '../core/clock.js';
import type { GateResult } from './gates.js';

/** Quiet time after the last edit before a speculative gate run starts. */
export const SPECULATIVE_DEBOUNCE_MS = 1_500;

export interface SpeculativeDeps {
  clock: Clock;
  debounceMs?: number;
  /** Id of the working tree as the verify step will see it. */
  treeHash: () => Promise<string>;
  /** One plain pass of the gates (no flaky re-runs), stopped when `signal` aborts. */
  run: (signal: AbortSignal) => Promise<GateResult[]>;
  emit: (type: string, data: Record<string, unknown>) => void;
}

/** A finished speculative run: the gate results for exactly this tree. */
export interface SpeculativeResult {
  tree: string;
  results: GateResult[];
  /** Clock time the run started and finished. */
  startedAt: number;
  finishedAt: number;
}

interface Attempt {
  controller: AbortController;
  phase: 'waiting' | 'running';
  done: Promise<void>;
}

/**
 * Runs the gates in the background while the model is still thinking, so the loop's check can
 * reuse the result instead of waiting for it. `touch()` after every edit (re)starts a debounced
 * run, cancelling the one before; at most one run is in flight. A result is kept only when the
 * tree hashed the same before and after the run, and `take(tree)` hands it out only for exactly
 * that tree: a speculative result never stands in for a different tree.
 */
export class SpeculativeChecks {
  private attempt: Attempt | undefined;
  private result: SpeculativeResult | undefined;
  private stopped = false;

  constructor(private readonly deps: SpeculativeDeps) {}

  /** The working tree changed: drop any pending or running attempt and start a new one. */
  touch(): void {
    if (this.stopped) return;
    const previous = this.attempt;
    previous?.controller.abort();
    const controller = new AbortController();
    const attempt: Attempt = { controller, phase: 'waiting', done: Promise.resolve() };
    attempt.done = this.runAttempt(attempt, previous?.done).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      this.deps.emit('loop.speculative_failed', { error: (err as Error).message });
    });
    this.attempt = attempt;
  }

  /**
   * The gate results for `tree`, or undefined when there are none to reuse. Waits for a run that
   * is already going (it is the same work the caller would start); a run still in its debounce
   * is cancelled instead, since the caller runs the gates now anyway.
   */
  async take(tree: string): Promise<SpeculativeResult | undefined> {
    const attempt = this.attempt;
    if (attempt?.phase === 'waiting') attempt.controller.abort();
    else if (attempt) await attempt.done;
    const hit = this.result?.tree === tree ? this.result : undefined;
    this.deps.emit(hit ? 'loop.speculative_hit' : 'loop.speculative_miss', {
      tree,
      ...(hit ? { gateMs: hit.finishedAt - hit.startedAt } : {}),
    });
    return hit;
  }

  /** Session over: cancel whatever is running and accept no more work. */
  async stop(): Promise<void> {
    this.stopped = true;
    const attempt = this.attempt;
    attempt?.controller.abort();
    await attempt?.done;
  }

  private async runAttempt(attempt: Attempt, previous: Promise<void> | undefined): Promise<void> {
    const { signal } = attempt.controller;
    // A function, not the field: it changes across the awaits below.
    const cancelled = (): boolean => signal.aborted;
    await this.deps.clock.sleep(this.deps.debounceMs ?? SPECULATIVE_DEBOUNCE_MS, signal);
    // One run at a time: the cancelled one must have stopped before this one starts.
    await previous;
    if (cancelled()) return;
    attempt.phase = 'running';
    const before = await this.deps.treeHash();
    if (cancelled() || this.result?.tree === before) return;
    const startedAt = this.deps.clock.now();
    const results = await this.deps.run(signal);
    if (cancelled()) return;
    // An edit landed mid-run (or a command changed files): the results match no single tree.
    if ((await this.deps.treeHash()) !== before) return;
    const finishedAt = this.deps.clock.now();
    this.result = { tree: before, results, startedAt, finishedAt };
    this.deps.emit('loop.speculative_ready', { tree: before, ms: finishedAt - startedAt });
  }
}
