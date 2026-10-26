import { describe, expect, it } from 'vitest';
import type { UsageCallRecord, WasteRecord } from '../../../src/usage/ledger.js';
import { aggregateUsage, fmtTokens, usageTotals } from '../../../src/usage/report.js';

const call = (over: Partial<UsageCallRecord> = {}): UsageCallRecord => ({
  kind: 'call',
  id: 'c',
  ts: 0,
  runId: 'r1',
  taskId: 'M1.T01',
  cycle: 1,
  step: 1,
  purpose: 'main',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  ok: true,
  usage: { uncached: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 50, output: 10 },
  tokens: 160,
  budgetTokens: 160,
  usd: 0.01,
  ms: 5,
  requestHash: '0123456789abcdef',
  ...over,
});

const waste = (over: Partial<WasteRecord> = {}): WasteRecord => ({
  kind: 'waste',
  id: 'w',
  ts: 0,
  runId: 'r1',
  taskId: 'M1.T01',
  cycle: 1,
  step: 3,
  waste: 'repeat_read',
  tokens: 400,
  detail: 'repeat read',
  ...over,
});

describe('usage aggregation', () => {
  it('groups by purpose and task, and keeps each waste kind separate', () => {
    const records = [
      call(),
      call({
        id: 'c2',
        purpose: 'retry',
        retryOf: 'x',
        errorSignature: '429',
        tokens: 200,
        usd: 0.02,
      }),
      call({ id: 'c3', taskId: 'M1.T02', purpose: 'subagent', tokens: 50, usd: 0.005 }),
      waste(),
      waste({ id: 'w2', waste: 'compaction_no_shrink', tokens: 300, detail: 'did not shrink' }),
    ];
    const d = aggregateUsage(records);
    expect(d.calls).toBe(3);
    expect(d.tokens.total).toBe(410);
    expect(d.byPurpose.find((p) => p.purpose === 'main')).toMatchObject({
      calls: 1,
      tokens: 160,
    });
    expect(d.byPurpose.find((p) => p.purpose === 'retry')).toMatchObject({
      calls: 1,
      tokens: 200,
    });
    expect(d.waste.repeatReads).toMatchObject({ count: 1, tokens: 400 });
    expect(d.waste.retries).toMatchObject({ calls: 1, tokens: 200 });
    expect(d.waste.compactions).toMatchObject({ count: 1, tokens: 300 });
    // Saved repeat-read tokens are not "avoidable spend"; retries and wasted folds are.
    expect(d.waste.avoidableTokens).toBe(500);

    const only = aggregateUsage(records, { taskId: 'M1.T02' });
    expect(only.calls).toBe(1);
    expect(only.taskIds).toEqual(['M1.T02']);
  });

  it('sums a task the same way for the status line', () => {
    const totals = usageTotals([call(), call({ id: 'c2', tokens: 40 })], { taskId: 'M1.T01' });
    expect(totals).toMatchObject({ calls: 2, tokens: 200, input: 300, cacheRead: 100, output: 20 });
    expect(fmtTokens(1_500)).toBe('1.5k');
    expect(fmtTokens(2_000_000)).toBe('2.00M');
  });
});
