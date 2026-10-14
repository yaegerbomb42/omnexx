import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths, runsDir } from '../../../src/core/paths.js';
import type { Message } from '../../../src/providers/types.js';
import {
  chatTitle,
  listChats,
  readSavedChat,
  transcriptEntries,
} from '../../../src/tui/chat-history.js';
import { isolatedEnv } from '../../support/tmp.js';

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'fix the arcade nav buttons' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'x' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] },
];

describe('chat history', () => {
  it('titles a chat by its first request, without the plan-mode preamble', () => {
    expect(chatTitle(history)).toBe('Fix the arcade nav buttons');
    expect(
      chatTitle([
        {
          role: 'user',
          content: [{ type: 'text', text: '[Plan mode] Do nothing.\n\nadd dark mode' }],
        },
      ]),
    ).toBe('Add dark mode');
    expect(chatTitle([])).toBe('Untitled chat');
    expect(
      chatTitle([{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(100) }] }]),
    ).toHaveLength(60);
  });

  it('turns a conversation back into panel lines', () => {
    expect(transcriptEntries(history)).toEqual([
      { kind: 'user', text: 'fix the arcade nav buttons' },
      { kind: 'out', text: 'Looking.' },
      { kind: 'act', text: 'read_file' },
      { kind: 'out', text: 'Fixed.' },
    ]);
  });

  it('lists chats for a folder newest first, hiding ones that were continued', async () => {
    const paths = resolvePaths(await isolatedEnv());
    const save = async (id: string, chat: object): Promise<void> => {
      await mkdir(join(runsDir(paths), id), { recursive: true });
      await writeFile(join(runsDir(paths), id, 'chat.json'), JSON.stringify(chat));
    };
    await save('chat_a', { cwd: '/repo', savedAt: 1, history });
    await save('chat_b', { cwd: '/repo', savedAt: 3, history, resumedFrom: 'chat_c' });
    await save('chat_c', { cwd: '/repo', savedAt: 2, history });
    await save('chat_d', { cwd: '/other', savedAt: 4, history });
    await save('chat_e', { cwd: '/repo', savedAt: 5, history: [] });
    const chats = await listChats(paths, '/repo');
    expect(chats.map((c) => c.id)).toEqual(['chat_b', 'chat_a']);
    expect(chats[0]).toMatchObject({ title: 'Fix the arcade nav buttons', messages: 1 });

    expect((await readSavedChat(paths, '/repo', 'chat_a')).history).toEqual(history);
    await expect(readSavedChat(paths, '/repo', 'chat_d')).rejects.toThrow(/no saved chat/);
    await expect(readSavedChat(paths, '/repo', '../x')).rejects.toThrow(/not a chat id/);
  });
});
