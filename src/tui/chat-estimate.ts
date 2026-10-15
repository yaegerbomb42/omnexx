import {
  estimateRun,
  formatEstimate,
  formatRemaining,
  type RunEstimate,
} from '../core/run-estimate.js';
import { appendRunSample, loadRunHistory } from '../core/run-history.js';
import type { Telemetry } from '../telemetry/aggregate.js';
import type { TodoItem } from '../tools/todo.js';

/** Token and spend totals at one moment, to measure a stretch of work by difference. */
interface Totals {
  fresh: number;
  cached: number;
  usd: number;
}

function totalsOf(t: Telemetry): Totals {
  return {
    fresh: t.tokens.input - t.tokens.cacheRead + t.tokens.output,
    cached: t.tokens.cacheRead,
    usd: t.usd,
  };
}

interface Work {
  startedAt: number;
  before: Totals;
  goalChars: number;
  nodes: number;
  estimate: RunEstimate | undefined;
}

const doneCount = (items: readonly TodoItem[]): number =>
  items.filter((i) => i.status === 'done').length;

/**
 * Chat's side of run estimates. A plan-mode reply leaves a plan (its length and todo count);
 * the next ordinary message approves it, and that work gets an estimate from similar past chat
 * work, a "~2 min left" as its todos are ticked off, and is recorded when it ends.
 */
export class ChatEstimate {
  private plan: { chars: number; nodes: number } | undefined;
  private work: Work | undefined;

  constructor(
    private readonly file: string | undefined,
    private readonly facts: { model: () => string; repoFiles: number },
  ) {}

  /** A plan-mode reply landed: the next ordinary message carries it out. */
  planned(chars: number, nodes: number): void {
    this.plan = { chars, nodes };
  }

  /** A message is going out. Returns the line to show when it starts approved work. */
  async start(planMode: boolean, now: number, t: Telemetry): Promise<string | undefined> {
    const plan = this.plan;
    this.plan = undefined;
    this.work = undefined;
    if (planMode || !plan) return undefined;
    const history = this.file ? await loadRunHistory(this.file) : [];
    const estimate = estimateRun(history, {
      kind: 'chat',
      model: this.facts.model(),
      goalChars: plan.chars,
      repoFiles: this.facts.repoFiles,
      planned: true,
      nodes: plan.nodes,
    });
    this.work = {
      startedAt: now,
      before: totalsOf(t),
      goalChars: plan.chars,
      nodes: plan.nodes,
      estimate,
    };
    return formatEstimate(estimate);
  }

  /** The todo list changed during approved work: the time left, if anything is known. */
  progress(items: readonly TodoItem[], now: number): string | undefined {
    const w = this.work;
    if (!w) return undefined;
    return formatRemaining(w.estimate, {
      elapsedMs: now - w.startedAt,
      done: doneCount(items),
      total: items.length,
    });
  }

  /** The approved work ended: record what it took (unless it was stopped). */
  async finish(completed: boolean, now: number, t: Telemetry): Promise<void> {
    const w = this.work;
    this.work = undefined;
    if (!w || !completed || !this.file) return;
    const after = totalsOf(t);
    await appendRunSample(this.file, {
      at: now,
      kind: 'chat',
      model: this.facts.model(),
      goalChars: w.goalChars,
      planned: true,
      nodes: w.nodes,
      repoFiles: this.facts.repoFiles,
      wallMs: Math.max(1, now - w.startedAt),
      freshTokens: Math.max(0, after.fresh - w.before.fresh),
      cachedTokens: Math.max(0, after.cached - w.before.cached),
      usd: Math.max(0, after.usd - w.before.usd),
    }).catch(() => undefined);
  }
}
