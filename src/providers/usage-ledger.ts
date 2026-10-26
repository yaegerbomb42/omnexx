import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { estimateTokens } from '../core/tokens.js';
import type { Usage } from './types.js';

/**
 * Why a model call was made. Every attempt is tagged before it can be recorded: a failed
 * attempt is a zero-usage `retry` call (and repeated identical errors become a waste row), while
 * the successful retry keeps the parent purpose and an `attempt` count.
 */
export const CALL_PURPOSES = [
  'main',
  'subagent',
  'retry',
  'compaction',
  'verification',
  'reviewer',
  'planning',
  'judge',
  'chat',
] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

export const WASTE_KINDS = [
  'repeat_read',
  'retry_same_error',
  'compaction_no_shrink',
  'context_resend',
] as const;
export type WasteKind = (typeof WASTE_KINDS)[number];

export interface LedgerUsage {
  uncached: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface CallMeta {
  purpose: CallPurpose;
  taskId?: string | undefined;
  cycle?: number | undefined;
  turn?: number | undefined;
  step?: string | undefined;
  attempt?: number | undefined;
  /** Uncalibrated size of the prompt this call sent, for the waste report. */
  promptTokens?: number | undefined;
  /** Prompt size of the previous call in the same conversation, for context re-send. */
  previousPromptTokens?: number | undefined;
}

export interface CallRecord extends CallMeta {
  v: 1;
  kind: 'call';
  ts: number;
  runId: string;
  /** Bench task id, or the run id for an ordinary run. */
  label: string;
  model: string;
  provider: string;
  usage: LedgerUsage;
  /** All prompt tokens the provider billed (cached or not). */
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  usd: number;
}

export interface WasteRecord {
  v: 1;
  kind: 'waste';
  ts: number;
  runId: string;
  label: string;
  taskId?: string;
  cycle?: number;
  turn?: number;
  waste: WasteKind;
  /** Tokens avoided (repeat reads) or re-spent (retries, context re-sends). */
  tokens: number;
  usd?: number;
  /** How many events this record aggregates, when the recorder coalesces. */
  count?: number;
  detail?: string;
}

export type LedgerRecord = CallRecord | WasteRecord;

const nonNeg = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : 0);

export function ledgerUsage(u: Usage): LedgerUsage {
  return {
    uncached: nonNeg(u.uncached),
    cacheWrite: nonNeg(u.cacheWrite5m) + nonNeg(u.cacheWrite1h),
    cacheRead: nonNeg(u.cacheRead),
    output: nonNeg(u.output),
  };
}

/** Human-readable purpose for a legacy role string (planner, cheap, review, …). */
export function purposeForRole(role: string): CallPurpose {
  switch (role) {
    case 'worker':
      return 'main';
    case 'subagent':
      return 'subagent';
    case 'review':
    case 'audit':
      return 'reviewer';
    case 'judge':
      return 'judge';
    case 'planner':
    case 'planning':
      return 'planning';
    case 'cheap':
      return 'compaction';
    case 'retry':
      return 'retry';
    case 'chat':
      return 'chat';
    case 'verify':
    case 'verification':
    case 'repro_test':
      return 'verification';
    default:
      return 'main';
  }
}

/** A stable signature for "the same error again": numbers, paths and quoted values vary. */
export function errorSignature(message: string): string {
  return message
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/["'`][^"'`]{0,120}["'`]/g, '<str>')
    .replace(/(?:\/[\w.-]+){2,}/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

/**
 * Append-only spend attribution. It never rewrites a line: a crash can lose the tail, but it can
 * never corrupt or delete what was already recorded. `recordRetry` coalesces repeated failures
 * with one error signature into a single waste row so the report says "this failed 6 times".
 */
export class UsageLedger {
  private readonly retries = new Map<string, { count: number; tokens: number; usd: number }>();
  private readonly compaction = new Map<string, { before: number; after: number; count: number }>();

  constructor(
    readonly file: string,
    private readonly runId: string,
    private readonly label: string,
    private readonly now: () => number = Date.now,
  ) {}

  private append(record: LedgerRecord): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // Losing a ledger line is better than failing the run it describes.
    }
  }

  recordCall(
    m: CallMeta,
    call: {
      model: string;
      provider: string;
      usage: Usage;
      usd: number;
      taskId?: string | undefined;
    },
  ): void {
    const usage = ledgerUsage(call.usage);
    const inputTokens = usage.uncached + usage.cacheWrite + usage.cacheRead;
    const taskId = call.taskId ?? m.taskId;
    const record: CallRecord = {
      v: 1,
      kind: 'call',
      ts: this.now(),
      runId: this.runId,
      label: this.label,
      purpose: m.purpose,
      ...(taskId ? { taskId } : {}),
      ...(m.cycle !== undefined ? { cycle: m.cycle } : {}),
      ...(m.turn !== undefined ? { turn: m.turn } : {}),
      ...(m.step ? { step: m.step } : {}),
      ...(m.attempt !== undefined ? { attempt: m.attempt } : {}),
      ...(m.promptTokens !== undefined ? { promptTokens: m.promptTokens } : {}),
      ...(m.previousPromptTokens !== undefined
        ? { previousPromptTokens: m.previousPromptTokens }
        : {}),
      model: call.model,
      provider: call.provider,
      usage,
      inputTokens,
      outputTokens: usage.output,
      cacheRead: usage.cacheRead,
      usd: nonNeg(call.usd),
    };
    this.append(record);
  }

  /** A file read was answered from the cache: its bytes never entered the context. */
  recordReadSaved(info: {
    taskId?: string | undefined;
    cycle?: number | undefined;
    turn?: number | undefined;
    tokens: number;
    path?: string | undefined;
    fromStep?: number | undefined;
  }): void {
    this.append({
      v: 1,
      kind: 'waste',
      ts: this.now(),
      runId: this.runId,
      label: this.label,
      ...(info.taskId ? { taskId: info.taskId } : {}),
      ...(info.cycle !== undefined ? { cycle: info.cycle } : {}),
      ...(info.turn !== undefined ? { turn: info.turn } : {}),
      waste: 'repeat_read',
      tokens: nonNeg(info.tokens),
      count: 1,
      ...(info.path ? { detail: `${info.path} unchanged` } : {}),
      ...(info.fromStep !== undefined
        ? { detail: `${info.path ?? 'file'} unchanged since step ${String(info.fromStep)}` }
        : {}),
    });
  }

  /**
   * A retry after an identical error signature. The first failure is ordinary failover; the
   * second and later are the waste (they re-send the same prompt to the same wall).
   */
  recordRetry(info: {
    signature: string;
    tokens: number;
    taskId?: string | undefined;
    cycle?: number | undefined;
    turn?: number | undefined;
    detail?: string | undefined;
  }): void {
    const sig = errorSignature(info.signature);
    const seen = this.retries.get(sig);
    const tokens = nonNeg(info.tokens);
    if (!seen) {
      this.retries.set(sig, { count: 1, tokens, usd: 0 });
      return;
    }
    seen.count++;
    seen.tokens += tokens;
    this.append({
      v: 1,
      kind: 'waste',
      ts: this.now(),
      runId: this.runId,
      label: this.label,
      ...(info.taskId ? { taskId: info.taskId } : {}),
      ...(info.cycle !== undefined ? { cycle: info.cycle } : {}),
      ...(info.turn !== undefined ? { turn: info.turn } : {}),
      waste: 'retry_same_error',
      tokens: seen.tokens,
      count: seen.count,
      detail: info.detail ?? sig,
    });
  }

  /** A fold that did not make the conversation meaningfully smaller still paid for a summary. */
  recordCompaction(info: {
    before: number;
    after: number;
    taskId?: string | undefined;
    cycle?: number | undefined;
    detail?: string | undefined;
  }): void {
    const before = nonNeg(info.before);
    const after = nonNeg(info.after);
    if (!before || after < before * 0.95) return;
    const key = `${String(info.cycle ?? 0)}:${info.taskId ?? ''}`;
    const seen = this.compaction.get(key) ?? { before, after, count: 0 };
    seen.count++;
    seen.before = before;
    seen.after = after;
    this.compaction.set(key, seen);
    this.append({
      v: 1,
      kind: 'waste',
      ts: this.now(),
      runId: this.runId,
      label: this.label,
      ...(info.taskId ? { taskId: info.taskId } : {}),
      ...(info.cycle !== undefined ? { cycle: info.cycle } : {}),
      waste: 'compaction_no_shrink',
      tokens: Math.max(0, after - before),
      count: seen.count,
      detail: `context ${String(before)} → ${String(after)} tokens${info.detail ? `; ${info.detail}` : ''}`,
    });
  }

  /** Context that was re-sent across turns, recorded at the end of a task/cycle. */
  recordContextResend(info: {
    tokens: number;
    cached?: number | undefined;
    taskId?: string | undefined;
    cycle?: number | undefined;
    turns?: number | undefined;
  }): void {
    if (!(info.tokens > 0)) return;
    this.append({
      v: 1,
      kind: 'waste',
      ts: this.now(),
      runId: this.runId,
      label: this.label,
      ...(info.taskId ? { taskId: info.taskId } : {}),
      ...(info.cycle !== undefined ? { cycle: info.cycle } : {}),
      waste: 'context_resend',
      tokens: nonNeg(info.tokens),
      count: info.turns ?? 0,
      ...(info.cached !== undefined ? { usd: nonNeg(info.cached) } : {}),
      detail: `${String(info.turns ?? 0)} turns re-sent the growing conversation`,
    });
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/** Every valid ledger record, oldest first. A torn last line from a crash is skipped. */
export function readUsageLedger(file: string): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const line of readLines(file)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { v?: unknown; kind?: unknown };
      if (r.v === 1 && (r.kind === 'call' || r.kind === 'waste')) out.push(r as LedgerRecord);
    } catch {
      // Torn write: everything before it is still trustworthy.
    }
  }
  return out;
}

export interface PurposeBreakdown {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  usd: number;
  share: number;
}

export interface UsageReport {
  query: string;
  runs: string[];
  labels: string[];
  firstAt?: number;
  lastAt?: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  usd: number;
  byPurpose: Record<string, PurposeBreakdown>;
  byTask: Record<string, { calls: number; tokens: number; usd: number }>;
  byStep: { step: string; calls: number; tokens: number; usd: number }[];
  waste: {
    repeatRead: { events: number; tokensSaved: number; files: number };
    retries: { events: number; tokens: number; signatures: number };
    compactions: { events: number; tokens: number };
    contextResend: { tokens: number; cached: number; turns: number };
    totalTokens: number;
  };
  attribution: { tagged: number; untagged: number; share: number };
}

const matches = (record: LedgerRecord, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [record.label, record.runId, record.taskId ?? ''].map((f) => f.toLowerCase());
  return fields.some((f) => f === q || f.startsWith(q) || f.includes(q));
};

const stepKey = (r: CallRecord): string =>
  r.step ?? (r.cycle === undefined ? 'run' : `c${String(r.cycle)}.t${String(r.turn ?? 0)}`);

/**
 * Explain one task's spend. Calls are reconciled with the ledger's own waste rows; the report
 * also recomputes context re-send from consecutive calls so old runs (before waste recording)
 * can still be explained.
 */
export function summarizeUsage(records: readonly LedgerRecord[], query: string): UsageReport {
  const picked = records.filter((r) => matches(r, query));
  const calls = picked.filter((r): r is CallRecord => r.kind === 'call');
  const waste = picked.filter((r): r is WasteRecord => r.kind === 'waste');
  const byPurpose: Record<string, PurposeBreakdown> = {};
  const byTask: UsageReport['byTask'] = {};
  const steps = new Map<string, { calls: number; tokens: number; usd: number }>();
  const runs = new Set<string>();
  const labels = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let usd = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  let tagged = 0;

  for (const c of calls) {
    runs.add(c.runId);
    labels.add(c.label);
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
    cacheRead += c.cacheRead;
    usd += c.usd;
    firstAt = firstAt === undefined ? c.ts : Math.min(firstAt, c.ts);
    lastAt = lastAt === undefined ? c.ts : Math.max(lastAt, c.ts);
    if (CALL_PURPOSES.includes(c.purpose)) tagged++;
    const purpose = byPurpose[c.purpose] ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      usd: 0,
      share: 0,
    };
    purpose.calls++;
    purpose.inputTokens += c.inputTokens;
    purpose.outputTokens += c.outputTokens;
    purpose.cacheRead += c.cacheRead;
    purpose.usd += c.usd;
    byPurpose[c.purpose] = purpose;

    const task = c.taskId ?? 'unassigned';
    const t = byTask[task] ?? { calls: 0, tokens: 0, usd: 0 };
    t.calls++;
    t.tokens += c.inputTokens + c.outputTokens;
    t.usd += c.usd;
    byTask[task] = t;

    const key = stepKey(c);
    const s = steps.get(key) ?? { calls: 0, tokens: 0, usd: 0 };
    s.calls++;
    s.tokens += c.inputTokens + c.outputTokens;
    s.usd += c.usd;
    steps.set(key, s);
  }
  for (const p of Object.values(byPurpose))
    p.share = usd > 0 ? p.usd / usd : inputTokens > 0 ? p.inputTokens / inputTokens : 0;

  // Context re-sent: each call repeats the previous prompt; count the overlap once per turn.
  const conversations = new Map<string, CallRecord[]>();
  for (const c of calls) {
    const key = `${c.runId}\u0000${c.taskId ?? ''}\u0000${c.purpose}`;
    const list = conversations.get(key) ?? [];
    list.push(c);
    conversations.set(key, list);
  }
  let resend = 0;
  let resendCached = 0;
  let resendTurns = 0;
  for (const list of conversations.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < list.length; i++) {
      const c = list[i];
      const prev = list[i - 1];
      if (!c || !prev) continue;
      const overlap = Math.min(prev.inputTokens, c.inputTokens);
      if (overlap <= 0) continue;
      resend += overlap;
      resendCached += Math.min(c.cacheRead, overlap);
      resendTurns++;
    }
  }

  const repeatReads = waste.filter((w) => w.waste === 'repeat_read');
  const retries = waste.filter((w) => w.waste === 'retry_same_error');
  const compactions = waste.filter((w) => w.waste === 'compaction_no_shrink');
  const totalSaved = repeatReads.reduce((s, w) => s + w.tokens, 0);
  const totalRetry = retries.reduce((s, w) => s + w.tokens, 0);
  const totalCompaction = compactions.reduce((s, w) => s + w.tokens, 0);
  const recordedResend = waste
    .filter((w) => w.waste === 'context_resend')
    .reduce((s, w) => s + w.tokens, 0);

  return {
    query,
    runs: [...runs].sort(),
    labels: [...labels].sort(),
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {}),
    calls: calls.length,
    inputTokens,
    outputTokens,
    cacheRead,
    usd,
    byPurpose,
    byTask,
    byStep: [...steps.entries()]
      .map(([step, s]) => ({ step, ...s }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 12),
    waste: {
      repeatRead: {
        events: repeatReads.length,
        tokensSaved: totalSaved,
        files: new Set(repeatReads.flatMap((w) => (w.detail ? [w.detail.split(' ')[0]] : []))).size,
      },
      retries: {
        events: retries.length,
        tokens: totalRetry,
        signatures: new Set(retries.map((w) => w.detail ?? '')).size,
      },
      compactions: { events: compactions.length, tokens: totalCompaction },
      contextResend: {
        tokens: Math.max(recordedResend, resend),
        cached: resendCached,
        turns: resendTurns,
      },
      totalTokens: totalSaved + totalRetry + totalCompaction + Math.max(recordedResend, resend),
    },
    attribution: {
      tagged,
      untagged: calls.length - tagged,
      share: calls.length ? tagged / calls.length : 1,
    },
  };
}

/** Tokens a re-read would have cost, for the savings estimate on a plain string. */
export const savedTokens = (content: string): number => estimateTokens(content);
