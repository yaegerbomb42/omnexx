import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PriceConfig } from '../../../src/config/schema.js';
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
} from '../../../src/providers/types.js';
import {
  UntaggedCallError,
  UsageLedger,
  withCallAttribution,
  withUsageLedger,
} from '../../../src/usage/ledger.js';

const price: PriceConfig = {
  id: 'test-model',
  input: 1,
  output: 2,
  cache_write_5m: 1,
  cache_write_1h: 1,
  cache_read: 0.1,
};

const req = (text = 'hi'): CompletionRequest => ({
  model: 'test-model',
  system: [{ text: 'system' }],
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  maxTokens: 100,
  messageBreakpoints: [],
});

const res = (model = 'test-model'): CompletionResponse => ({
  content: [{ type: 'text', text: 'ok' }],
  stopReason: 'end_turn',
  model,
  usage: { uncached: 100, cacheWrite5m: 20, cacheWrite1h: 0, cacheRead: 40, output: 10 },
});

class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly requests: CompletionRequest[] = [];
  private answered = 0;

  complete(r: CompletionRequest): Promise<CompletionResponse> {
    this.answered++;
    this.requests.push(r);
    return Promise.resolve(res(r.model));
  }
}

describe('usage ledger', () => {
  it('records an attributed call with task, purpose and price', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-ledger-'));
    const ledger = new UsageLedger(join(dir, 'usage-ledger.jsonl'), 'r1');
    const inner = new FakeProvider();
    const provider = withUsageLedger(inner, { ledger, priceFor: () => price, now: () => 1000 });

    await withCallAttribution(
      { purpose: 'main', taskId: 'M1.T01', cycle: 2, step: 3, label: 'worker' },
      () => provider.complete(req()),
    );

    // The Proxy keeps the inner provider's own fields and methods usable.
    expect(inner.requests).toHaveLength(1);
    const [record] = ledger.read();
    expect(record).toMatchObject({
      kind: 'call',
      runId: 'r1',
      taskId: 'M1.T01',
      purpose: 'main',
      cycle: 2,
      step: 3,
      label: 'worker',
      provider: 'fake',
      model: 'test-model',
      ok: true,
      tokens: 170,
      usage: { uncached: 100, cacheRead: 40, output: 10 },
    });
    expect(record?.kind === 'call' ? record.usd : 0).toBeCloseTo((100 + 20 + 4 + 20) / 1_000_000);
    expect(ledger.taskTotals('M1.T01')).toMatchObject({ calls: 1, tokens: 170, output: 10 });
  });

  it('refuses an untagged call instead of letting it escape the ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-ledger-'));
    const ledger = new UsageLedger(join(dir, 'usage-ledger.jsonl'), 'r1');
    const provider = withUsageLedger(new FakeProvider(), { ledger });
    await expect(provider.complete(req())).rejects.toBeInstanceOf(UntaggedCallError);
    expect(ledger.read()).toEqual([]);
  });

  it('labels a repeat of a failed request as a retry with the same error signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-ledger-'));
    const ledger = new UsageLedger(join(dir, 'usage-ledger.jsonl'), 'r1');
    let fail = true;
    const inner: Provider = {
      name: 'fake',
      complete: (r) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error('529 overloaded'));
        }
        return Promise.resolve(res(r.model));
      },
    };
    const provider = withUsageLedger(inner, { ledger, priceFor: () => price });
    const scope = { purpose: 'main' as const, taskId: 'M1.T01', cycle: 1, step: 1 };
    await expect(withCallAttribution(scope, () => provider.complete(req()))).rejects.toThrow('529');
    await withCallAttribution(scope, () => provider.complete(req()));

    const calls = ledger.read().filter((r) => r.kind === 'call');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ ok: false, errorSignature: '<n> overloaded' });
    expect(calls[1]).toMatchObject({
      ok: true,
      purpose: 'retry',
      retryOf: calls[0]?.kind === 'call' ? calls[0].requestHash : undefined,
      errorSignature: '<n> overloaded',
    });
  });

  it('keeps task totals across a resumed process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-ledger-'));
    const path = join(dir, 'usage-ledger.jsonl');
    const first = new UsageLedger(path, 'r1');
    const provider = withUsageLedger(new FakeProvider(), { ledger: first, priceFor: () => price });
    await withCallAttribution({ purpose: 'main', taskId: 'M1.T01', cycle: 1, step: 1 }, () =>
      provider.complete(req()),
    );

    const resumed = new UsageLedger(path, 'r1');
    expect(resumed.taskTotals('M1.T01')).toMatchObject({ calls: 1, tokens: 170 });
  });
});
