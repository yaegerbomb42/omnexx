import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import type { CompletionRequest, ContentBlock, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { CHAT_SYSTEM } from '../../src/tui/code-chat.js';
import { Session } from '../../src/tui/session.js';
import { makeRepo } from '../support/harness.js';
import { isolatedEnv } from '../support/tmp.js';

const PLAN =
  'I looked at hub.html. Plan: 1) bigger tiles 2) dark theme. Go ahead, or change anything?';

const lastUserText = (req: CompletionRequest): string => {
  const texts = req.messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content)
    .flatMap((b) => (b.type === 'text' ? [b.text] : []));
  return texts.at(-1) ?? '';
};

/** A model that follows the chat prompt: a vague ask gets read + plan; an approval gets the edit. */
function senior(seen: CompletionRequest[]): Provider {
  return {
    name: 'anthropic',
    complete(req) {
      seen.push(req);
      const last = req.messages.at(-1);
      const fresh = last?.role === 'user' && last.content.some((b) => b.type === 'text');
      const approved = /^yes/i.test(lastUserText(req));
      const tool = (name: string, input: unknown): ContentBlock[] => [
        { type: 'tool_use', id: `t${seen.length}`, name, input },
      ];
      const reply = approved ? 'Done: tiles and theme updated.' : PLAN;
      const action = approved
        ? tool('write_file', { path: 'hub.html', content: '<main class="dark big"></main>\n' })
        : tool('read', { path: 'hub.html' });
      return Promise.resolve({
        content: fresh ? action : [{ type: 'text', text: reply }],
        stopReason: fresh ? 'tool_use' : 'end_turn',
        usage: emptyUsage(),
        model: req.model,
      });
    },
  };
}

describe('chat proposes a plan instead of asking questions', () => {
  it('tells the model to investigate and propose, not to ask a menu of questions', () => {
    expect(CHAT_SYSTEM).toMatch(/Never reply with a menu of questions/);
    expect(CHAT_SYSTEM).toMatch(/Go ahead, or change anything\?/);
    expect(CHAT_SYSTEM).not.toMatch(/Ask a question instead of guessing/);
  });

  it('tries actions outside the repo (asking for approval) instead of refusing them', () => {
    expect(CHAT_SYSTEM).toMatch(/Never refuse or tell them to do it themselves before trying/);
  });

  it('answers a greeting with one short line, not a codebase pitch', () => {
    expect(CHAT_SYSTEM).toMatch(
      /greeting or small talk gets one short line, like "How can I help today\?"/,
    );
  });

  it('a vague ask reads the project and replies with a plan; "yes" carries it out', async () => {
    const repo = await makeRepo({ 'hub.html': '<main></main>\n' });
    const env = await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' });
    const seen: CompletionRequest[] = [];
    const io: CliIO = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: repo,
      isTTY: false,
      fetch: () => Promise.reject(new Error('no network in tests')),
      makeProvider: () => senior(seen),
    };
    const s = new Session(io, () => Promise.resolve(0));

    await s.submit('improve the arcade UI');
    const system = seen[0]?.system.map((b) => b.text).join('\n') ?? '';
    expect(system).toContain('Never reply with a menu of questions');
    const results = seen.flatMap((r) => r.messages).flatMap((m) => m.content);
    expect(results.some((b) => b.type === 'tool_result')).toBe(true);
    expect(s.entries.map((e) => e.text).join('\n')).toContain('Plan: 1)');
    expect(await readFile(join(repo, 'hub.html'), 'utf8')).toBe('<main></main>\n');

    await s.submit('yes, go ahead');
    expect(await readFile(join(repo, 'hub.html'), 'utf8')).toBe('<main class="dark big"></main>\n');
    expect(JSON.stringify(seen.at(-1)?.messages)).toContain('Plan: 1)');
  });
});
