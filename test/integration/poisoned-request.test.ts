import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import { ProviderError } from '../../src/errors.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { startTestRun } from '../support/harness.js';

const plan = {
  milestones: [{ id: 'M1', title: 'Fix', tasks: [{ id: 'M1.T01', title: 'Fix add', checks: [] }] }],
};

/** Up for trivial requests, but every real (tool-carrying) request gets a 500. */
const choker: Provider = {
  name: 'anthropic',
  complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (req.tools.length)
      return Promise.reject(
        new ProviderError('500 Internal Server Error', { retryable: true, status: 500 }),
      );
    return Promise.resolve({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: emptyUsage(),
      model: req.model,
    });
  },
};

/** A real outage: everything fails. */
const down: Provider = {
  name: 'anthropic',
  complete: () =>
    Promise.reject(
      new ProviderError('500 Internal Server Error', { retryable: true, status: 500 }),
    ),
};

describe('a request the provider keeps choking on', () => {
  it('ends the cycle as stuck instead of retrying it forever', async () => {
    const t = await startTestRun({ provider: choker, plan });
    await runBaseline(t.run);
    const v = await runOneCycle(t.run, 'M1.T01');
    expect(v.verdict).toBe('reject');
    const events = await readEvents(t.run.events.path);
    const stuck = events.find((e) => e.type === 'stuck.in_cycle');
    expect(stuck?.signal).toBe('poisoned_request');
    // Bounded: a few minutes of backoff (the provider cools down between tries), not forever.
    expect(events.filter((e) => e.type === 'provider.retry').length).toBeLessThan(10);
  });

  it('keeps waiting through a real outage, where the health check fails too', async () => {
    const t = await startTestRun({ provider: down, plan });
    await runBaseline(t.run);
    const cycle = runOneCycle(t.run, 'M1.T01').catch(() => undefined);
    // Let the retry loop run through many backoffs on the fake clock, then stop the run.
    const retries = async () =>
      (await readEvents(t.run.events.path)).filter((e) => e.type === 'provider.retry').length;
    for (let i = 0; i < 1_000 && (await retries()) <= 5; i++)
      await new Promise((r) => setTimeout(r, 10));
    t.run.abort.abort();
    // Let the cycle finish writing before the temp dirs are removed.
    await cycle;
    const events = await readEvents(t.run.events.path);
    expect(events.some((e) => e.type === 'stuck.in_cycle')).toBe(false);
    expect(events.filter((e) => e.type === 'provider.retry').length).toBeGreaterThan(5);
  });
});
