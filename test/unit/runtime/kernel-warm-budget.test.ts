import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AdaptiveRuntimeKernel } from '../../../src/runtime/kernel/kernel.js';
import { fetchLiveRegistry } from '../../../src/runtime/kernel/registry.js';
import type { Tool } from '../../../src/tools/types.js';

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    schema: z.object({}),
    readOnly: true,
    run: () => Promise.resolve({ content: '' }),
  };
}

function kernel(warmTimeoutMs: number): AdaptiveRuntimeKernel {
  return new AdaptiveRuntimeKernel({
    enabled: true,
    ollamaUrl: 'http://127.0.0.1:9',
    ollamaModel: 'none',
    embedModel: 'none',
    attentionCeiling: 0.65,
    worktree: process.cwd(),
    maxWindow: 100_000,
    maxMounted: 6,
    reselectEvery: 2,
    registry: false,
    localDiscovery: false,
    publicSkills: false,
    warmTimeoutMs,
  });
}

describe('bug #2: first-turn warm is time-bounded', () => {
  it('planTurn returns within the warm budget when the warm stalls', async () => {
    const k = kernel(50);
    let release!: () => void;
    (k as unknown as { runWarm: () => Promise<void> }).runWarm = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const t0 = Date.now();
    const plan = await k.planTurn({
      objective: 'do a thing',
      allTools: [fakeTool('read')],
      defaultMaxTokens: 1000,
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(plan.warmTimedOut).toBe(true);
    release();
  });

  it('fetchLiveRegistry stops paginating at the total budget and marks truncated', async () => {
    let calls = 0;
    const fetchImpl = (async (_u: unknown, init?: { signal?: AbortSignal }) => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            servers: [{ server: { name: 'a/b', version: '1' } }],
            metadata: { nextCursor: 'c1' },
          }),
          { status: 200 },
        );
      }
      return new Promise<Response>((_r, rej) =>
        init?.signal?.addEventListener('abort', () => {
          rej(new Error('aborted'));
        }),
      );
    }) as unknown as typeof fetch;
    const snap = await fetchLiveRegistry({ fetchImpl, timeoutMs: 100 });
    expect(snap.truncated).toBe(true);
    expect(calls).toBe(2);
  });
});
