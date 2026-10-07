import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { CliIO } from '../../src/cli/io.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
} from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { Session } from '../../src/tui/session.js';
import { makeRepo } from '../support/harness.js';
import { isolatedEnv } from '../support/tmp.js';

const lastUserText = (req: CompletionRequest): string =>
  (req.messages.at(-1)?.content ?? [])
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n');

async function chatSession(provider: Provider) {
  const repo = await makeRepo({ 'src/a.js': 'export const a = 1;\n' });
  const io: CliIO = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
    cwd: repo,
    isTTY: false,
    makeProvider: () => provider,
  };
  return new Session(io, () => Promise.resolve(0));
}

function reply(content: ContentBlock[], req: CompletionRequest): CompletionResponse {
  return {
    content,
    stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: emptyUsage(),
    model: req.model,
  };
}

describe('chat: steering, todo, actions and stop', () => {
  it('a message typed mid-turn reaches the very next model request', async () => {
    const seen: CompletionRequest[] = [];
    const box: { s?: Session } = {};
    const provider: Provider = {
      name: 'anthropic',
      complete(req) {
        // Copy at call time: the loop keeps appending to the same messages array.
        seen.push({ ...req, messages: structuredClone(req.messages) });
        const turn = req.messages.filter((m) => m.role === 'assistant').length;
        if (turn === 0) {
          // The person types while the agent is still on its first step.
          void box.s?.submit('actually, use tabs');
          return Promise.resolve(
            reply(
              [
                { type: 'text', text: 'Let me plan this.' },
                {
                  type: 'tool_use',
                  id: 't1',
                  name: 'todo',
                  input: {
                    items: [
                      { text: 'read a.js', status: 'in_progress' },
                      { text: 'edit', status: 'pending' },
                    ],
                  },
                },
                { type: 'tool_use', id: 't2', name: 'read', input: { path: 'src/a.js' } },
              ],
              req,
            ),
          );
        }
        return Promise.resolve(reply([{ type: 'text', text: 'Done, with tabs.' }], req));
      },
    };
    const s = await chatSession(provider);
    box.s = s;
    await s.submit('format a.js');
    expect(lastUserText(seen[1] as CompletionRequest)).toMatch(
      /while you were working[\s\S]*> actually, use tabs/,
    );
    const text = s.entries.map((e) => `${e.kind}:${e.text}`).join('\n');
    expect(text).toContain('think:Let me plan this.');
    expect(text).toContain('act:updating the todo list');
    expect(text).toContain('act:reading src/a.js');
    expect(text).toContain('system:sent to the agent; it reads this at its next step');
    expect(text).toContain('out:Done, with tabs.');
    expect(s.todos.map((t) => t.status)).toEqual(['in_progress', 'pending']);
  });

  it('esc stops the turn and keeps what was done', async () => {
    const box: { s?: Session } = {};
    let calls = 0;
    const provider: Provider = {
      name: 'anthropic',
      complete(req) {
        calls++;
        if (calls === 1) box.s?.interrupt();
        return Promise.resolve(
          reply(
            [{ type: 'tool_use', id: `t${calls}`, name: 'read', input: { path: 'src/a.js' } }],
            req,
          ),
        );
      },
    };
    const s = await chatSession(provider);
    box.s = s;
    await s.submit('read forever');
    expect(calls).toBe(1);
    expect(s.entries.map((e) => e.text).join('\n')).toMatch(/stopped\. tell me what to do instead/);
  });
});
