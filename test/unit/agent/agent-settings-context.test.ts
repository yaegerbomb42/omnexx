import { describe, expect, it } from 'vitest';
import { contextTokens, manageContext } from '../../../src/agent/compaction.js';
import { contextProfile } from '../../../src/core/agent-levels.js';
import type { Message } from '../../../src/providers/types.js';

const first: Message = { role: 'user', content: [{ type: 'text', text: 'Work on M1.T01' }] };

/** first, then `n` rounds of tool call + result of `size` chars, then a closing reply. */
function convo(n: number, size: number): Message[] {
  const out: Message[] = [first];
  for (let i = 0; i < n; i++) {
    out.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'bash', input: { command: `step ${i}` } }],
    });
    out.push({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: `t${i}`, content: `${i}:${'x'.repeat(size)}` }],
    });
  }
  return out;
}

const settings = (level: number) => {
  const p = contextProfile(level);
  return {
    clearAt: p.clearAt,
    keepToolResults: p.keepToolResults,
    compactAt: p.compactAt,
    keepTurns: p.keepTurns,
  };
};

const summarize = () => Promise.resolve(undefined);

describe('context level → compaction', () => {
  it('keeps a long conversation within the 5k budget at level 1', async () => {
    const messages = convo(30, 2_000);
    expect(contextTokens(messages)).toBeGreaterThan(10_000);
    const kept = await manageContext(messages, first, settings(1), summarize, () => undefined);
    expect(contextTokens(kept)).toBeLessThanOrEqual(5_000);
    expect(kept[0]).toEqual(first);
  });

  it('keeps the whole conversation at level 10 (500k)', async () => {
    const messages = convo(30, 2_000);
    const events: string[] = [];
    const kept = await manageContext(messages, first, settings(10), summarize, (e) => {
      events.push(e.kind);
    });
    expect(kept).toEqual(messages);
    expect(events).toEqual([]);
  });
});
