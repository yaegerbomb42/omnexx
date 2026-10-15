import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { budgetSchema } from '../../../src/config/schema.js';
import { runAgentLoop, type LoopDeps } from '../../../src/agent/loop.js';
import type { Tool } from '../../../src/tools/types.js';
import { ScriptedProvider, type ScriptedTurn } from '../../support/scripted-provider.js';
import { FakeClock } from '../../support/clock.js';
import { toolContext } from '../../support/tool-context.js';
import { makeRepo } from '../../support/harness.js';

const DELAY_MS = 30;

/** Tools that record how many calls overlapped and the order they started and finished in. */
function probe() {
  const state = { active: 0, maxActive: 0, log: [] as string[] };
  const schema = z.strictObject({ id: z.string() });
  const make = (name: string, concurrent: boolean): Tool<typeof schema> => ({
    name,
    description: name,
    schema,
    readOnly: concurrent,
    concurrent,
    async run(input) {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      state.log.push(`start ${input.id}`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      state.active--;
      state.log.push(`end ${input.id}`);
      return { content: `result ${input.id}` };
    },
  });
  return { state, tools: [make('peek', true), make('poke', false)] as Tool[] };
}

async function runTurn(calls: NonNullable<ScriptedTurn['tools']>, tools: Tool[]) {
  const provider = new ScriptedProvider(({ turn }) =>
    turn === 0 ? { tools: calls } : { text: 'done' },
  );
  const toolCtx = await toolContext(await makeRepo());
  const deps: LoopDeps = {
    provider,
    models: [
      {
        provider: 'scripted',
        alias: 'm',
        id: 'm',
        price: budgetFreePrice(),
      },
    ],
    tools,
    toolCtx,
    budget: budgetSchema.parse({}),
    maxTokens: 1_000,
    clock: new FakeClock(),
    events: toolCtx.events,
    spentUsd: () => 0,
    onUsage: () => Promise.resolve(),
    control: () => Promise.resolve('continue'),
  };
  const res = await runAgentLoop(
    {
      system: [{ text: 's' }],
      first: { role: 'user', content: [{ type: 'text', text: 'go' }] },
      tools: [],
    },
    deps,
  );
  const results = (res.messages[2]?.content ?? []).flatMap((b) =>
    b.type === 'tool_result' ? [b.content] : [],
  );
  return { res, results };
}

function budgetFreePrice(): LoopDeps['models'][number]['price'] {
  return { id: 'm', input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };
}

describe('parallel tool calls', () => {
  it('runs consecutive concurrency-safe calls at once and keeps result order', async () => {
    const { state, tools } = probe();
    const { results } = await runTurn(
      ['a', 'b', 'c'].map((id) => ({ name: 'peek', input: { id } })),
      tools,
    );
    expect(state.maxActive).toBe(3);
    expect(results).toEqual(['result a', 'result b', 'result c']);
  });

  it('keeps writes ordered: a write waits for earlier reads and later reads wait for it', async () => {
    const { state, tools } = probe();
    const { results } = await runTurn(
      [
        { name: 'peek', input: { id: 'r1' } },
        { name: 'peek', input: { id: 'r2' } },
        { name: 'poke', input: { id: 'w' } },
        { name: 'peek', input: { id: 'r3' } },
      ],
      tools,
    );
    expect(state.maxActive).toBe(2);
    const at = (s: string) => state.log.indexOf(s);
    expect(at('start w')).toBeGreaterThan(Math.max(at('end r1'), at('end r2')));
    expect(at('start r3')).toBeGreaterThan(at('end w'));
    expect(results).toEqual(['result r1', 'result r2', 'result w', 'result r3']);
  });

  it('never overlaps tools that are not marked concurrent', async () => {
    const { state, tools } = probe();
    await runTurn(
      ['x', 'y'].map((id) => ({ name: 'poke', input: { id } })),
      tools,
    );
    expect(state.maxActive).toBe(1);
  });
});
