import type { LedgerRecord, TaskTotals, UsageCallRecord, WasteRecord } from './ledger.js';

/** Pure aggregation for `omnexx usage`: records in, a breakdown (and its waste section) out. */

export interface UsageFilter {
  taskId?: string;
  runId?: string;
}

export interface PurposeRow {
  purpose: string;
  calls: number;
  tokens: number;
  usd: number;
  share: number;
}

export interface TaskRow {
  taskId: string;
  calls: number;
  tokens: number;
  usd: number;
}

export interface StepRow {
  taskId: string;
  step: number;
  calls: number;
  tokens: number;
  usd: number;
}

export interface RepeatReadRow {
  path: string;
  count: number;
  tokens: number;
  lastStep: number;
}

export interface RetryRow {
  signature: string;
  calls: number;
  tokens: number;
}

export interface UsageWaste {
  repeatReads: {
    count: number;
    tokens: number;
    paths: RepeatReadRow[];
  };
  retries: {
    calls: number;
    tokens: number;
    signatures: RetryRow[];
  };
  compactions: {
    count: number;
    tokens: number;
    details: string[];
  };
  contextResent: {
    calls: number;
    tokens: number;
  };
  /** Retries + non-shrinking compactions: spend the harness can prevent. Repeat reads are the
   * other side of the ledger: tokens the guard saved, not tokens wasted. */
  avoidableTokens: number;
}

export interface UsageBreakdown {
  runIds: string[];
  taskIds: string[];
  calls: number;
  tokens: { total: number; input: number; cacheRead: number; output: number };
  usd: number;
  byPurpose: PurposeRow[];
  byTask: TaskRow[];
  byModel: TaskRow[];
  steps: StepRow[];
  waste: UsageWaste;
  /** Sum of the ledger's budget-weighted tokens for the selected tasks. */
  budgetTokens: number;
}

const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

function matches(record: LedgerRecord, filter: UsageFilter): boolean {
  if (filter.runId !== undefined && record.runId !== filter.runId) return false;
  if (filter.taskId !== undefined && record.taskId !== filter.taskId) return false;
  return true;
}

/** Group rows by a key, summing calls/tokens/usd, then sort largest token share first. */
function groupCalls(
  records: readonly UsageCallRecord[],
  key: (r: UsageCallRecord) => string,
  make: (
    k: string,
    calls: number,
    tokens: number,
    usd: number,
  ) => { calls: number; tokens: number; usd: number },
): { key: string; calls: number; tokens: number; usd: number }[] {
  const groups = new Map<string, { calls: number; tokens: number; usd: number }>();
  for (const r of records) {
    const k = key(r);
    const g = groups.get(k) ?? { calls: 0, tokens: 0, usd: 0 };
    g.calls++;
    g.tokens += n(r.tokens);
    g.usd += n(r.usd);
    groups.set(k, g);
  }
  return [...groups.entries()]
    .map(([k, g]) => ({ key: k, ...make(k, g.calls, g.tokens, g.usd) }))
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}

export function aggregateUsage(
  records: readonly LedgerRecord[],
  filter: UsageFilter = {},
): UsageBreakdown {
  const selected = records.filter((r) => matches(r, filter));
  const calls = selected.filter((r): r is UsageCallRecord => r.kind === 'call');
  const wasteRecords = selected.filter((r): r is WasteRecord => r.kind === 'waste');
  const totalTokens = calls.reduce((s, r) => s + n(r.tokens), 0);
  const input = calls.reduce(
    (s, r) =>
      s +
      n(r.usage.uncached) +
      n(r.usage.cacheWrite5m) +
      n(r.usage.cacheWrite1h) +
      n(r.usage.cacheRead),
    0,
  );
  const cacheRead = calls.reduce((s, r) => s + n(r.usage.cacheRead), 0);
  const output = calls.reduce((s, r) => s + n(r.usage.output), 0);
  const usd = calls.reduce((s, r) => s + n(r.usd), 0);
  const budget = calls.reduce((s, r) => s + n(r.budgetTokens), 0);

  const byPurpose = groupCalls(
    calls,
    (r) => r.purpose,
    (_k, callCount, tokens, spend) => ({
      calls: callCount,
      tokens,
      usd: spend,
      share: share(tokens, totalTokens),
    }),
  ).map((r) => ({
    purpose: r.key,
    calls: r.calls,
    tokens: r.tokens,
    usd: r.usd,
    share: (r as unknown as { share: number }).share,
  }));

  const byTask = groupCalls(
    calls,
    (r) => r.taskId,
    (_k, callCount, tokens, spend) => ({ calls: callCount, tokens, usd: spend }),
  ).map((r) => ({ taskId: r.key, calls: r.calls, tokens: r.tokens, usd: r.usd }));

  const byModel = groupCalls(
    calls,
    (r) => `${r.provider}:${r.model}`,
    (_k, callCount, tokens, spend) => ({ calls: callCount, tokens, usd: spend }),
  ).map((r) => ({ taskId: r.key, calls: r.calls, tokens: r.tokens, usd: r.usd }));

  const steps = groupCalls(
    calls,
    (r) => `${r.taskId}\u0000${String(r.step)}`,
    (_k, callCount, tokens, spend) => ({ calls: callCount, tokens, usd: spend }),
  ).map((r) => {
    const [taskId = '', step = '0'] = r.key.split('\u0000');
    return { taskId, step: Number(step), calls: r.calls, tokens: r.tokens, usd: r.usd };
  });

  const repeatByPath = new Map<string, RepeatReadRow>();
  let repeatCount = 0;
  let repeatTokens = 0;
  const compactionDetails: string[] = [];
  let compactionCount = 0;
  let compactionTokens = 0;
  for (const r of wasteRecords) {
    if (r.waste === 'repeat_read') {
      repeatCount++;
      repeatTokens += n(r.tokens);
      const path = r.path ?? '?';
      const row = repeatByPath.get(path) ?? { path, count: 0, tokens: 0, lastStep: 0 };
      row.count++;
      row.tokens += n(r.tokens);
      row.lastStep = Math.max(row.lastStep, n(r.step));
      repeatByPath.set(path, row);
    } else if (r.waste === 'compaction_no_shrink') {
      compactionCount++;
      compactionTokens += n(r.tokens);
      if (compactionDetails.length < 8) compactionDetails.push(r.detail);
    }
  }

  const retryBySignature = new Map<string, RetryRow>();
  let retryCalls = 0;
  let retryTokens = 0;
  for (const r of calls) {
    if (r.purpose !== 'retry' && r.retryOf === undefined) continue;
    retryCalls++;
    retryTokens += n(r.tokens);
    const signature = r.errorSignature ?? 'same request (no error recorded)';
    const row = retryBySignature.get(signature) ?? { signature, calls: 0, tokens: 0 };
    row.calls++;
    row.tokens += n(r.tokens);
    retryBySignature.set(signature, row);
  }

  return {
    runIds: [...new Set(selected.map((r) => r.runId))].sort(),
    taskIds: [...new Set(selected.map((r) => r.taskId))].sort(),
    calls: calls.length,
    tokens: { total: totalTokens, input, cacheRead, output },
    usd,
    budgetTokens: budget,
    byPurpose,
    byTask,
    byModel,
    steps: steps.sort((a, b) => b.tokens - a.tokens),
    waste: {
      repeatReads: {
        count: repeatCount,
        tokens: repeatTokens,
        paths: [...repeatByPath.values()].sort((a, b) => b.tokens - a.tokens),
      },
      retries: {
        calls: retryCalls,
        tokens: retryTokens,
        signatures: [...retryBySignature.values()].sort(
          (a, b) => b.tokens - a.tokens || b.calls - a.calls,
        ),
      },
      compactions: { count: compactionCount, tokens: compactionTokens, details: compactionDetails },
      contextResent: {
        calls: calls.filter((r) => n(r.usage.cacheRead) > 0).length,
        tokens: cacheRead,
      },
      avoidableTokens: retryTokens + compactionTokens,
    },
  };
}

/** A one-line totals view shared by `status --json` and the TUI. */
export function usageTotals(
  records: readonly LedgerRecord[],
  filter: UsageFilter = {},
): TaskTotals {
  const d = aggregateUsage(records, filter);
  return {
    calls: d.calls,
    usd: d.usd,
    tokens: d.tokens.total,
    budgetTokens: d.budgetTokens,
    input: d.tokens.input,
    cacheRead: d.tokens.cacheRead,
    output: d.tokens.output,
  };
}

export const fmtUsd = (usd: number): string =>
  usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;

export function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;
