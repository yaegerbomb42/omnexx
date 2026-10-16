import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { budgetSchema } from '../../../src/config/schema.js';
import {
  BATCH_HINT,
  BOOKKEEPING_HINT,
  runAgentLoop,
  type LoopDeps,
} from '../../../src/agent/loop.js';
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
  return runTurns([calls], tools);
}

async function runTurns(script: NonNullable<ScriptedTurn['tools']>[], tools: Tool[]) {
  const provider = new ScriptedProvider(({ turn }) => {
    const calls = script[turn];
    return calls ? { tools: calls } : { text: 'done' };
  });
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
  const hints = res.messages.flatMap((m, i) =>
    m.content.some((b) => b.type === 'text' && b.text === BATCH_HINT) ? [i] : [],
  );
  return { res, results, hints };
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

describe('batching hint', () => {
  const schema = z.strictObject({ id: z.string() });
  const tool = (name: string, readOnly: boolean): Tool<typeof schema> => ({
    name,
    description: name,
    schema,
    readOnly,
    concurrent: readOnly,
    run: () => Promise.resolve({ content: 'ok' }),
  });
  const tools = [tool('read', true), tool('search', true), tool('edit', false)] as Tool[];
  const one = (name: string) => [{ name, input: { id: name } }];

  it('is said once, after the first turn that explored with a single call', async () => {
    const both = [
      { name: 'read', input: { id: 'a' } },
      { name: 'search', input: { id: 'b' } },
    ];
    const { hints } = await runTurns([both, one('read'), one('search')], tools);
    // messages: 0 task, 1 assistant, 2 results of the batched turn, 3 assistant, 4 results of the lone read.
    expect(hints).toEqual([4]);
  });

  it('says once that a turn of only bookkeeping wasted a round trip', async () => {
    const notes = [tool('todo', true), tool('running_context', true), ...tools];
    const { res } = await runTurns([one('todo'), one('running_context')], notes);
    const said = res.messages.flatMap((m, i) =>
      m.content.some((b) => b.type === 'text' && b.text === BOOKKEEPING_HINT) ? [i] : [],
    );
    expect(said).toEqual([2]);
  });

  it('is not said once the model has started changing things', async () => {
    const { hints } = await runTurns([one('edit'), one('read')], tools);
    expect(hints).toEqual([]);
  });
});
