import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PriceConfig } from '../config/schema.js';
import { costUsd } from '../providers/pricing.js';
import {
  budgetTokens,
  totalInput,
  type CompletionRequest,
  type Provider,
  type Usage,
} from '../providers/types.js';

/**
 * The usage ledger: one append-only JSON line per model call, plus the waste the harness
 * removes (a repeat read it answered with a pointer, a compaction that did not shrink).
 *
 * Every record carries the purpose of the call and the task/step it belongs to, so `omnexx
 * usage` can answer "where did the tokens go?" without replaying a provider dashboard. The
 * ledger is deliberately separate from events.jsonl: events are for people and tools to stream,
 * the ledger is the billing-shaped record that survives crashes and is cheap to sum.
 */

export const CALL_PURPOSES = [
  'main',
  'subagent',
  'retry',
  'compaction',
  'verification',
  'reviewer',
  'planner',
  'judge',
  'describe',
  'chat',
] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

export interface CallAttribution {
  purpose: CallPurpose;
  /** Plan task id, "plan", "chat", or "untasked" when there is no task. */
  taskId: string;
  /** Run cycle the call belongs to. */
  cycle: number;
  /** Turn number inside the current loop (1-based); 0 for side calls. */
  step: number;
  /** The provider role that asked for the call (worker, cheap, review, ...). */
  label?: string;
}

const attribution = new AsyncLocalStorage<CallAttribution>();

/** Thrown when a wrapped provider is called outside an attribution scope. */
export class UntaggedCallError extends Error {
  constructor(model: string) {
    super(
      `untagged LLM call (${model}): every provider call must run inside withCallAttribution()`,
    );
    this.name = 'UntaggedCallError';
  }
}

export function withCallAttribution<T>(scope: CallAttribution, fn: () => Promise<T>): Promise<T> {
  return attribution.run(scope, fn);
}

export function currentAttribution(): CallAttribution | undefined {
  return attribution.getStore();
}

export interface UsageCallRecord {
  kind: 'call';
  id: string;
  ts: number;
  runId: string;
  taskId: string;
  cycle: number;
  step: number;
  purpose: CallPurpose;
  label?: string;
  provider: string;
  model: string;
  ok: boolean;
  usage: Usage;
  /** Raw input + output tokens, before cache discounts. */
  tokens: number;
  /** Tokens as they count against a budget (cache reads weighted like omnexx's cycle cap). */
  budgetTokens: number;
  usd: number;
  ms: number;
  requestHash: string;
  retryOf?: string;
  errorSignature?: string;
  error?: string;
}

export type WasteKind = 'repeat_read' | 'compaction_no_shrink' | 'context_resend';

export interface WasteRecord {
  kind: 'waste';
  id: string;
  ts: number;
  runId: string;
  taskId: string;
  cycle: number;
  step: number;
  waste: WasteKind;
  /** Tokens the waste cost or saved (saved for repeat_read). */
  tokens: number;
  /** What happened, short enough for a terminal. */
  detail: string;
  path?: string;
  /** Step where the earlier read/call happened, when there is one. */
  sinceStep?: number;
}

export type LedgerRecord = UsageCallRecord | WasteRecord;

export interface TaskTotals {
  calls: number;
  usd: number;
  tokens: number;
  budgetTokens: number;
  input: number;
  cacheRead: number;
  output: number;
}

export const emptyTaskTotals = (): TaskTotals => ({
  calls: 0,
  usd: 0,
  tokens: 0,
  budgetTokens: 0,
  input: 0,
  cacheRead: 0,
  output: 0,
});

const finite = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0;

/** The usage shape in a provider response, made safe for the ledger. */
export function safeUsage(u: Partial<Usage> | undefined): Usage {
  return {
    uncached: finite(u?.uncached),
    cacheWrite5m: finite(u?.cacheWrite5m),
    cacheWrite1h: finite(u?.cacheWrite1h),
    cacheRead: finite(u?.cacheRead),
    output: finite(u?.output),
  };
}

const countTokens = (u: Usage): number => totalInput(u) + finite(u.output);

const shortHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * A stable fingerprint of a request without storing its prompt. The same prompt sent again
 * (a retry, a 400 re-ask, a repeat after failover) has the same hash and is labelled `retry`.
 */
export function requestFingerprint(
  req: Pick<CompletionRequest, 'model' | 'system' | 'tools' | 'messages'>,
): string {
  return shortHash(JSON.stringify([req.model, req.system, req.tools, req.messages]));
}

/** Error identity for "retried with the same error signature". */
export function errorSignature(err: unknown): string {
  const e = err as { message?: unknown; status?: unknown; name?: unknown };
  const status = typeof e.status === 'number' ? `${e.status} ` : '';
  const name = typeof e.name === 'string' && e.name !== 'Error' ? `${e.name}: ` : '';
  const message = typeof e.message === 'string' ? e.message : String(err);
  const normalized = message
    .replace(/\b\d{2,}\b/g, '<n>')
    .replace(/[0-9a-f]{8,}/gi, '<hex>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return `${status}${name}${normalized}`;
}

/** Map the existing role strings (used by cheapComplete and the loop) to a ledger purpose. */
export function purposeForRole(role: string | undefined): CallPurpose {
  switch (role) {
    case 'subagent':
      return 'subagent';
    case 'compaction':
    case 'cheap':
      return 'compaction';
    case 'review':
    case 'audit':
    case 'spec_judge':
    case 'judge':
      return 'reviewer';
    case 'spec_tests':
    case 'repro_test':
    case 'verification':
      return 'verification';
    case 'planner':
      return 'planner';
    case 'describe':
      return 'describe';
    case 'chat':
      return 'chat';
    case 'retry':
      return 'retry';
    default:
      return 'main';
  }
}

export class UsageLedger {
  private readonly totals = new Map<string, TaskTotals>();
  private loaded = false;
  private seq = 0;
  private dirReady = false;

  constructor(
    readonly path: string,
    readonly runId: string,
  ) {}

  /** Create the directory once, so the first append is not a lost record on a fresh run. */
  private ensureDir(): void {
    if (this.dirReady) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.dirReady = true;
  }

  /** Load totals from an earlier process once; a resumed run keeps its task caps honest. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    for (const record of parseLedger(readFileSync(this.path, 'utf8'))) {
      this.addToTotals(record);
      this.seq++;
    }
  }

  private addToTotals(record: LedgerRecord): void {
    if (record.kind !== 'call') return;
    const t = this.totals.get(record.taskId) ?? emptyTaskTotals();
    t.calls++;
    t.usd += finite(record.usd);
    t.tokens += finite(record.tokens);
    t.budgetTokens += finite(record.budgetTokens);
    t.input += totalInput(record.usage);
    t.cacheRead += finite(record.usage.cacheRead);
    t.output += finite(record.usage.output);
    this.totals.set(record.taskId, t);
  }

  append(record: LedgerRecord): void {
    this.ensureLoaded();
    this.ensureDir();
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.addToTotals(record);
  }

  private id(kind: string, ts: number): string {
    this.seq++;
    return `${this.runId}:${String(ts)}:${String(this.seq)}:${kind}`;
  }

  recordCall(
    data: Omit<UsageCallRecord, 'kind' | 'id' | 'ts' | 'runId' | 'tokens' | 'budgetTokens'> & {
      ts?: number;
    },
  ): UsageCallRecord {
    const ts = data.ts ?? Date.now();
    const usage = safeUsage(data.usage);
    const record: UsageCallRecord = {
      kind: 'call',
      id: this.id('c', ts),
      ts,
      runId: this.runId,
      ...data,
      usage,
      tokens: countTokens(usage),
      budgetTokens: budgetTokens(usage),
    };
    this.append(record);
    return record;
  }

  recordWaste(
    data: Omit<WasteRecord, 'kind' | 'id' | 'ts' | 'runId'> & { ts?: number },
  ): WasteRecord {
    const ts = data.ts ?? Date.now();
    const record: WasteRecord = {
      kind: 'waste',
      id: this.id('w', ts),
      ts,
      runId: this.runId,
      ...data,
    };
    this.append(record);
    return record;
  }

  /** Spend for one task from the ledger, including calls made before a resume. */
  taskTotals(taskId: string): TaskTotals {
    this.ensureLoaded();
    return this.totals.get(taskId) ?? emptyTaskTotals();
  }

  allTotals(): ReadonlyMap<string, TaskTotals> {
    this.ensureLoaded();
    return this.totals;
  }

  /** The current file contents; [] when the run has not made a call yet. */
  read(): LedgerRecord[] {
    if (!existsSync(this.path)) return [];
    return parseLedger(readFileSync(this.path, 'utf8'));
  }
}

export function parseLedger(text: string): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        const { kind } = parsed as { kind?: unknown };
        if (kind === 'call' || kind === 'waste') out.push(parsed as LedgerRecord);
      }
    } catch {
      // A torn last line from a crash is skipped; every earlier record is intact.
    }
  }
  return out;
}

export interface UsageLedgerOptions {
  ledger: UsageLedger;
  /** Resolve a model's price for the USD figure; unknown models record $0. */
  priceFor?: (provider: string, model: string) => PriceConfig | undefined;
  now?: () => number;
}

/**
 * Wrap a provider so every call is attributed and recorded. It never changes the request or
 * response. A call with no attribution throws before hitting the network: that is the test
 * that proves no call can silently escape the ledger.
 *
 * A Proxy forwards the inner provider's other properties (tests and diagnostics use them), so
 * wrapping a scripted provider never hides `requests` or provider-specific fields.
 */
export function withUsageLedger(inner: Provider, opts: UsageLedgerOptions): Provider {
  const now = opts.now ?? Date.now;
  /** Last failure by task + request hash: the next identical call is a retry of it. */
  const failures = new Map<string, { signature: string; at: number }>();

  const complete = async (req: CompletionRequest) => {
    const scope = currentAttribution();
    if (!scope) throw new UntaggedCallError(req.model);
    const requestHash = requestFingerprint(req);
    const key = `${scope.taskId}:${requestHash}`;
    const prior = failures.get(key);
    const effective = prior
      ? {
          ...scope,
          purpose: 'retry' as const,
          label: scope.label ?? 'retry',
        }
      : scope;
    const provider = req.route ?? inner.name;
    const started = now();
    try {
      const res = await inner.complete(req);
      const usage = safeUsage(res.usage);
      const price = opts.priceFor?.(provider, res.model);
      opts.ledger.recordCall({
        ts: started,
        taskId: effective.taskId,
        cycle: effective.cycle,
        step: effective.step,
        purpose: effective.purpose,
        ...(effective.label ? { label: effective.label } : {}),
        provider,
        model: res.model,
        ok: true,
        usage,
        usd: price ? costUsd(usage, price) : 0,
        ms: now() - started,
        requestHash,
        ...(prior ? { retryOf: requestHash, errorSignature: prior.signature } : {}),
      });
      failures.delete(key);
      return res;
    } catch (err) {
      const signature = errorSignature(err);
      failures.set(key, { signature, at: now() });
      opts.ledger.recordCall({
        ts: started,
        taskId: effective.taskId,
        cycle: effective.cycle,
        step: effective.step,
        purpose: effective.purpose,
        ...(effective.label ? { label: effective.label } : {}),
        provider,
        model: req.model,
        ok: false,
        usage: safeUsage(undefined),
        usd: 0,
        ms: now() - started,
        requestHash,
        errorSignature: signature,
        error: signature,
        ...(prior ? { retryOf: requestHash } : {}),
      });
      throw err;
    }
  };

  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'complete') return complete;
      const value: unknown = Reflect.get(target, prop, target);
      // Bind methods to the real provider: a class with private fields breaks when `this` is
      // the proxy. Plain data (`requests`, `name`) comes through unchanged.
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
