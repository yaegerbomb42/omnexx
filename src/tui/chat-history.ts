import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextOr } from '../core/atomic.js';
import { runsDir, type OmnexxPaths } from '../core/paths.js';
import type { Message } from '../providers/types.js';
import type { EntryKind } from './session.js';

/**
 * Saved chats for the editor's History: a human title (the first thing the person asked), when
 * it was last saved, and the transcript to show again when one is reopened.
 */

export const CHAT_FILE = 'chat.json';
const TITLE_CHARS = 60;

export interface SavedChat {
  cwd?: string;
  model?: string;
  savedAt?: number;
  history?: Message[];
  /** The chat this one continued, which History then leaves out. */
  resumedFrom?: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  savedAt: number;
  messages: number;
  model: string | null;
}

/** What the person typed, without the plan-mode preamble or steering markers. */
function askedText(m: Message): string | undefined {
  if (m.role !== 'user') return undefined;
  const text = m.content.find((b) => b.type === 'text')?.text;
  const asked = text?.replace(/^\[Plan mode\][^\n]*\n\n/, '').trim();
  if (!asked) return undefined;
  return asked;
}

export function chatTitle(history: readonly Message[]): string {
  const first = history.map(askedText).find(Boolean);
  if (!first) return 'Untitled chat';
  const line = first.replace(/\s+/g, ' ').trim();
  const short = line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

export function userMessageCount(history: readonly Message[]): number {
  return history.filter((m) => askedText(m) !== undefined).length;
}

/** The transcript as panel lines: what was asked, each tool call, and each reply. */
export function transcriptEntries(
  history: readonly Message[],
): { kind: EntryKind; text: string }[] {
  return history.flatMap((m) =>
    m.content.flatMap((b): { kind: EntryKind; text: string }[] => {
      if (b.type === 'text' && b.text.trim()) {
        if (m.role === 'assistant') return [{ kind: 'out', text: b.text }];
        const asked = askedText({ role: 'user', content: [b] });
        return asked ? [{ kind: 'user', text: asked }] : [];
      }
      if (b.type === 'tool_use') return [{ kind: 'act', text: b.name }];
      return [];
    }),
  );
}

async function readChat(dir: string): Promise<SavedChat | undefined> {
  const raw = await readTextOr(join(dir, CHAT_FILE), '');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SavedChat;
  } catch {
    return undefined;
  }
}

/** Saved chats for `cwd`, newest first; chats that another one continued are left out. */
export async function listChats(paths: OmnexxPaths, cwd: string): Promise<ChatSummary[]> {
  const ids = (await readdir(runsDir(paths)).catch(() => [] as string[])).filter((d) =>
    d.startsWith('chat_'),
  );
  const saved = await Promise.all(
    ids.map(async (id) => ({ id, chat: await readChat(join(runsDir(paths), id)) })),
  );
  const mine = saved.filter(
    (s): s is { id: string; chat: SavedChat & { history: Message[] } } =>
      s.chat?.cwd === cwd && Boolean(s.chat.history?.length),
  );
  const continued = new Set(mine.map((s) => s.chat.resumedFrom).filter(Boolean));
  return mine
    .filter((s) => !continued.has(s.id))
    .map((s) => ({
      id: s.id,
      title: chatTitle(s.chat.history),
      savedAt: s.chat.savedAt ?? 0,
      messages: userMessageCount(s.chat.history),
      model: s.chat.model ?? null,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

const CHAT_ID = /^chat_[A-Za-z0-9_-]+$/;

/** One saved chat for `cwd`, to reopen. */
export async function readSavedChat(
  paths: OmnexxPaths,
  cwd: string,
  id: string,
): Promise<SavedChat & { history: Message[] }> {
  if (!CHAT_ID.test(id)) throw new Error(`not a chat id: ${id}`);
  const chat = await readChat(join(runsDir(paths), id));
  if (chat?.cwd !== cwd || !chat.history?.length) throw new Error(`no saved chat ${id} here`);
  return { ...chat, history: chat.history };
}
