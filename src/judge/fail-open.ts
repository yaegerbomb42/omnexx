import type { JudgeUse } from '../config/schema.js';
import type { Clock } from '../core/clock.js';
import type { Redactor } from '../security/redact.js';
import type { Judge, JudgeQuestion, JudgeResult } from './types.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Half-open circuit breaker: after `failures` consecutive misses it opens (no calls), and after
 * `reprobeMs` it lets one probe through. Success closes it; a failed probe reopens it.
 */
export class CircuitBreaker {
  private consecutive = 0;
  private openedAt: number | undefined;
  private probing = false;

  constructor(
    private readonly failures: number,
    private readonly reprobeMs: number,
    private readonly clock: Clock,
  ) {}

  get state(): BreakerState {
    if (this.openedAt === undefined) return 'closed';
    return this.clock.now() - this.openedAt >= this.reprobeMs ? 'half-open' : 'open';
  }

  /** Whether a call may go out now. A half-open breaker admits exactly one probe at a time. */
  allow(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.probing) {
      this.probing = true;
      return true;
    }
    return false;
  }

  success(): void {
    this.consecutive = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  /** Returns true when this failure opened (or re-opened) the breaker. */
  failure(): boolean {
    this.probing = false;
    this.consecutive++;
    if (this.openedAt !== undefined) {
      this.openedAt = this.clock.now();
      return true;
    }
    if (this.consecutive >= this.failures) {
      this.openedAt = this.clock.now();
      return true;
    }
    return false;
  }
}

export interface JudgeEvents {
  emit(type: string, data: Record<string, unknown>): void;
}

/**
 * What the harness actually calls. Never throws, never waits on an open breaker, redacts the
 * state before it leaves the machine, logs judge.decision / judge.miss / judge.unavailable, and
 * consults the fallback judge when the primary misses.
 */
export class FailOpenJudge implements Judge {
  readonly kind: string;

  constructor(
    private readonly primary: Judge,
    private readonly fallback: Judge | undefined,
    private readonly breaker: CircuitBreaker,
    private readonly events: JudgeEvents,
    private readonly redactor: Redactor,
    private readonly enabledUses: ReadonlySet<JudgeUse>,
  ) {
    this.kind = primary.kind;
  }

  get breakerState(): BreakerState {
    return this.breaker.state;
  }

  enabled(use: JudgeUse): boolean {
    return this.primary.kind !== 'none' && this.enabledUses.has(use);
  }

  async ask(
    use: JudgeUse,
    state: unknown,
    questions: readonly JudgeQuestion[],
  ): Promise<JudgeResult> {
    if (!this.enabled(use))
      return { status: 'abstain', reason: 'judge disabled', judge: this.kind };
    const safeState = this.redactor.value(state);
    const safeQuestions = this.redactor.value([...questions]);
    let result: JudgeResult;
    if (this.breaker.allow()) {
      try {
        result = await this.primary.ask(use, safeState, safeQuestions);
      } catch (err) {
        result = {
          status: 'abstain',
          reason: `judge threw: ${(err as Error).message}`,
          judge: this.primary.kind,
        };
      }
      if (result.status === 'answered') this.breaker.success();
      else {
        this.events.emit('judge.miss', { use, judge: this.primary.kind, reason: result.reason });
        if (this.breaker.failure())
          this.events.emit('judge.unavailable', {
            judge: this.primary.kind,
            breaker: this.breaker.state,
          });
      }
    } else {
      result = { status: 'abstain', reason: 'breaker open', judge: this.primary.kind };
    }
    if (result.status === 'abstain' && this.fallback) {
      const fb = await this.fallback
        .ask(use, safeState, safeQuestions)
        .catch((err: unknown): JudgeResult => ({
          status: 'abstain',
          reason: String(err),
          judge: 'fallback',
        }));
      if (fb.status === 'answered') result = fb;
      else
        this.events.emit('judge.miss', { use, judge: fb.judge, reason: fb.reason, fallback: true });
    }
    if (result.status === 'answered') {
      this.events.emit('judge.decision', {
        use,
        judge: result.judge,
        questions: questions.map((q) => q.id),
        answers: result.answers,
        latencyMs: result.latencyMs,
        model: result.model,
        inputBytes: result.inputBytes,
        endpointHost: result.endpointHost,
      });
    }
    return result;
  }
}
