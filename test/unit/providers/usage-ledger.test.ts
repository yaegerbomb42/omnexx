import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Usage } from '../../../src/providers/types.js';
import {
  CALL_PURPOSES,
  errorSignature,
  readUsageLedger,
  summarizeUsage,
  UsageLedger,
} from '../../../src/providers/usage-ledger.js';

const usage = (input: number, output: number, cached = 0): Usage => ({
  uncached: input,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: cached,
  output,
});

async function ledgerFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'omnexx-ledger-')), 'ledger.jsonl');
}

describe('UsageLedger', () => {
  it('records every call with a purpose, task, step and token breakdown', async () => {
    const file = await ledgerFile();
    const ledger = new UsageLedger(file, 'run-1', 'task-01');
    ledger.recordCall(
      { purpose: 'main', taskId: 'M1.T01', cycle: 1, turn: 2, step: 'c1.t2', promptTokens: 900 },
      { model: 'm', provider: 'p', usage: usage(800, 50, 200), usd: 0.01 },
    );
    ledger.recordCall(
      { purpose: 'compaction', taskId: 'M1.T01', cycle: 1, turn: 0, step: 'c1.cheap' },
      { model: 'm', provider: 'p', usage: usage(400, 20), usd: 0.002 },
    );
    const records = readUsageLedger(file);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.kind === 'call' && CALL_PURPOSES.includes(r.purpose))).toBe(true);
    expect(records[0]).toMatchObject({
      runId: 'run-1',
      label: 'task-01',
      taskId: 'M1.T01',
      step: 'c1.t2',
      inputTokens: 1_000,
      cacheRead: 200,
      outputTokens: 50,
      usd: 0.01,
    });
  });

  it('aggregates by purpose, task and step and explains waste', async () => {
    const file = await ledgerFile();
    const ledger = new UsageLedger(file, 'run-1', 'task-01');
    for (let turn = 1; turn <= 3; turn++)
      ledger.recordCall(
        { purpose: 'main', taskId: 'M1.T01', cycle: 1, turn, step: `c1.t${turn}` },
        {
          model: 'm',
          provider: 'p',
          usage: usage(1_000 + turn * 100, 100, 500),
          usd: 0.01,
        },
      );
    ledger.recordCall(
      { purpose: 'subagent', taskId: 'M1.T01', cycle: 1, turn: 1, step: 'c1.t1' },
      { model: 'm', provider: 'p', usage: usage(300, 40), usd: 0.001 },
    );
    ledger.recordReadSaved({
      taskId: 'M1.T01',
      cycle: 1,
      turn: 2,
      tokens: 1_400,
      path: 'src/a.ts',
      fromStep: 1,
    });
    ledger.recordRetry({ signature: 'rate limit 429', tokens: 700, taskId: 'M1.T01' });
    ledger.recordRetry({ signature: 'rate limit 429', tokens: 800, taskId: 'M1.T01' });
    ledger.recordCompaction({ before: 10_000, after: 10_100, taskId: 'M1.T01', cycle: 1 });

    const report = summarizeUsage(readUsageLedger(file), 'task-01');
    expect(report.calls).toBe(4);
    expect(report.byPurpose.main).toMatchObject({ calls: 3, inputTokens: 5_100 });
    expect(report.byPurpose.subagent).toMatchObject({ calls: 1, inputTokens: 300 });
    expect(report.byStep.find((s) => s.step === 'c1.t3')).toMatchObject({ calls: 1 });
    expect(report.waste.repeatRead).toMatchObject({ events: 1, tokensSaved: 1_400, files: 1 });
    expect(report.waste.retries).toMatchObject({ events: 1, tokens: 1_500, signatures: 1 });
    expect(report.waste.compactions.events).toBe(1);
    expect(report.waste.contextResend.tokens).toBeGreaterThan(0);
    expect(report.attribution).toMatchObject({ tagged: 4, untagged: 0, share: 1 });
  });

  it('matches a task by bench label, task id or run id prefix', async () => {
    const file = await ledgerFile();
    const ledger = new UsageLedger(file, 'run-abcdef', 'hard10/task-01');
    ledger.recordCall(
      { purpose: 'main', taskId: 'M1.T01' },
      {
        model: 'm',
        provider: 'p',
        usage: usage(1, 1),
        usd: 0.001,
      },
    );
    const records = readUsageLedger(file);
    expect(summarizeUsage(records, 'hard10/task-01').calls).toBe(1);
    expect(summarizeUsage(records, 'M1.T01').calls).toBe(1);
    expect(summarizeUsage(records, 'run-abc').calls).toBe(1);
    expect(summarizeUsage(records, 'other').calls).toBe(0);
  });

  it('appends and never rewrites an earlier record', async () => {
    const file = await ledgerFile();
    const first = `${JSON.stringify({
      v: 1,
      kind: 'call',
      ts: 1,
      runId: 'old',
      label: 'old',
      purpose: 'main',
      model: 'm',
      provider: 'p',
      usage: { uncached: 1, cacheWrite: 0, cacheRead: 0, output: 1 },
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      usd: 0,
    })}\n`;
    await writeFile(file, first);
    new UsageLedger(file, 'new', 'new').recordCall(
      { purpose: 'main' },
      {
        model: 'm',
        provider: 'p',
        usage: usage(2, 2),
        usd: 0,
      },
    );
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(`${lines[0]}\n`).toBe(first);
    expect(readUsageLedger(file)).toHaveLength(2);
  });

  it('skips a torn last line and normalizes repeated error signatures', async () => {
    const file = await ledgerFile();
    await writeFile(file, '{"v":1,"kind":"call","ts":1,"runId":"r","label":"t",');
    expect(readUsageLedger(file)).toEqual([]);
    expect(errorSignature('HTTP 429 for /a/b/c.ts after 1200ms at 0xdead')).toBe(
      errorSignature('http 503 for /x/y/z.ts after 90ms at 0xbeef'),
    );
    expect(errorSignature('HTTP 429 for /a/b/c.ts after 1200ms at 0xdead')).toContain('<path>');
  });
});
