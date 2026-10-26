import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentLoop, type LoopDeps } from '../../../src/agent/loop.js';
import { budgetSchema } from '../../../src/config/schema.js';
import type { OmnexxEvent } from '../../../src/core/events.js';
import { ScriptedProvider } from '../../support/scripted-provider.js';
import { FakeClock } from '../../support/clock.js';
import { toolContext } from '../../support/tool-context.js';
import { makeRepo } from '../../support/harness.js';
import { todoTool } from '../../../src/tools/todo.js';

const price = { id: 'm', input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };
const model = (provider: string) => ({ provider, alias: 'm', id: 'm', price });

/**
 * The loop itself condenses: seven `todo` turns, then a final answer. The condense fires
 * before the eighth model call, the note lands in the first message, the folded transcript is
 * on disk, and the loop still finishes normally.
 */
describe('rolling memory in the agent loop', () => {
  it('condenses every 7 turns, keeps the last 2 raw, writes the transcript', async () => {
    const toolCtx = await toolContext(await makeRepo());
    const events: OmnexxEvent[] = [];
    toolCtx.events.onEvent((e) => {
      events.push(e);
    });
    const notes: string[] = [];
    const provider: ScriptedProvider = new ScriptedProvider(() => {
      // Seven working turns, then the answer — keyed on request count, not turn number,
      // because condensing rewrites the history the turn count is read from.
      if (provider.requests.length <= 7)
        return {
          text: `working step ${provider.requests.length}`,
          tools: [
            {
              name: 'todo',
              input: {
                items: [{ text: `step ${provider.requests.length}`, status: 'in_progress' }],
              },
            },
          ],
        };
      return { text: 'all done' };
    });
    const deps: LoopDeps = {
      provider,
      models: [model('a')],
      tools: [todoTool],
      toolCtx,
      budget: budgetSchema.parse({}),
      maxTokens: 1_000,
      clock: new FakeClock(),
      events: toolCtx.events,
      spentUsd: () => 0,
      onUsage: () => Promise.resolve(),
      control: () => Promise.resolve('continue'),
      rolling: {
        every: 7,
        keepTurns: 2,
        goal: 'M1.T01: loop test',
        onNote: (note) => {
          notes.push(note);
        },
      },
    };
    const result = await runAgentLoop(
      {
        system: [{ text: 's' }],
        first: { role: 'user', content: [{ type: 'text', text: 'go' }] },
        tools: [],
      },
      deps,
    );
    expect(result.end).toBe('done');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('# Memory (rolling)');
    expect(notes[0]).toContain('## Current goal\nM1.T01: loop test');
    expect(events.some((e) => e.type === 'context.condensed')).toBe(true);
    const condensed = events.find((e) => e.type === 'context.condensed');
    expect(condensed?.turnsSummarized).toBe(5);
    // The note is Slot 7 of the first message; the last 2 turns stay raw after it.
    const firstBlock = result.messages[0]?.content[1];
    expect(firstBlock?.type).toBe('text');
    if (firstBlock?.type === 'text') expect(firstBlock.text).toContain('# Memory (rolling)');
    const tailAssistants = result.messages.slice(1).filter((m) => m.role === 'assistant');
    expect(tailAssistants.length).toBeGreaterThanOrEqual(2);
    // The folded transcript is on disk for recall.
    const transcript = await readFile(join(toolCtx.store.logsDir, 'transcript.md'), 'utf8');
    expect(transcript).toContain('## Turns 1–5 (condensed at turn 7)');
    expect(transcript).toContain('working step 1');
  });
});
