import { estimateTokens } from '../core/tokens.js';
import type { ContentBlock, Message, SystemBlock, ToolSpec } from '../providers/types.js';

/**
 * The context inspector's model: everything a chat sends the model (system blocks, tool
 * definitions, the conversation) as a flat list of items the editor can show, edit and delete.
 * System and tool edits are overrides on top of the originals, so "restore defaults" just drops
 * them; conversation edits rewrite the history. Every function returns new values.
 */

export type ContextGroup = 'system' | 'tools' | 'notes' | 'chat';

export interface ContextItem {
  /** `system:<i>`, `tool:<name>`, `note:<id>` or `chat:<message>:<block>`. */
  id: string;
  group: ContextGroup;
  kind: 'system' | 'tool' | 'note' | ContentBlock['type'];
  /** Where it comes from: "Built-in", "MCP: github", "Skills", "Pinned from chat", … */
  source?: string;
  role?: Message['role'];
  label: string;
  text: string;
  tokens: number;
  /** Changed from the default (system and tools only). */
  edited: boolean;
  /** Hidden from the model; restore defaults brings it back (system and tools only). */
  removed: boolean;
  /** Images and provider blocks can be deleted but not edited. */
  editable: boolean;
}

/** A note the person added (or pinned from the chat): sent with every request as a system block. */
export interface ContextNote {
  readonly id: string;
  readonly text: string;
  /** Copied from a chat item, so it survives trimming and compaction. */
  readonly pinned: boolean;
}

/** Replacement text per system block / tool (null hides it), plus the person's own notes. */
export interface ContextOverrides {
  readonly system: Readonly<Record<number, string | null>>;
  readonly tools: Readonly<Record<string, string | null>>;
  readonly notes?: readonly ContextNote[];
}

export const EMPTY_OVERRIDES: ContextOverrides = { system: {}, tools: {}, notes: [] };

/** The heading every note block starts with, so the model knows who wrote it. */
export const NOTE_HEADING = '# Note from the person you are working with';

export interface ContextState {
  readonly system: readonly SystemBlock[];
  readonly tools: readonly ToolSpec[];
  readonly history: readonly Message[];
  readonly overrides: ContextOverrides;
}

const PREVIEW_CHARS = 60;

function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line;
}

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'tool_use':
      return JSON.stringify(b.input, null, 2);
    case 'tool_result':
      return b.content;
    case 'image':
      return `[image ${b.mediaType}]`;
    case 'opaque':
      return JSON.stringify(b.block);
  }
}

/** Tool names by call id, so a result can say which tool produced it. */
function toolNames(history: readonly Message[]): Map<string, string> {
  return new Map(
    history.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'tool_use' ? [[b.id, b.name] as const] : [])),
    ),
  );
}

function blockLabel(b: ContentBlock, role: Message['role'], names: Map<string, string>): string {
  switch (b.type) {
    case 'text':
      return `${role === 'user' ? 'You' : 'Agent'}: ${preview(b.text)}`;
    case 'tool_use':
      return `Tool call: ${b.name}`;
    case 'tool_result':
      return `Tool result: ${names.get(b.toolUseId) ?? '?'}${b.isError ? ' (error)' : ''}`;
    case 'image':
      return 'Image';
    case 'opaque':
      return `Provider block (${b.provider})`;
  }
}

function systemLabel(text: string, i: number): string {
  const heading = /^#+\s*(.+)$/m.exec(text)?.[1];
  return heading
    ? preview(heading)
    : i === 0
      ? 'Chat instructions'
      : `System block ${String(i + 1)}`;
}

/** Where a tool comes from: an MCP server, the skills loader, or omnexx itself. */
export function toolSource(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (mcp) return `MCP: ${mcp[1] ?? '?'}`;
  if (name === 'skill') return 'Skills';
  return 'Built-in';
}

function systemSource(text: string, i: number): string {
  if (i === 0) return 'Omnexx';
  if (text.startsWith('# Project instructions')) return 'CLAUDE.md / AGENTS.md';
  if (text.startsWith('# Lessons')) return 'Repo memory';
  if (text.startsWith('# Codebase map')) return 'Repo map';
  return 'Omnexx';
}

const noteBlock = (n: ContextNote): string => `${NOTE_HEADING}\n\n${n.text}`;

export function listContext(s: ContextState): ContextItem[] {
  const system = s.system.map((b, i): ContextItem => {
    const o = s.overrides.system[i];
    const text = typeof o === 'string' ? o : b.text;
    return {
      id: `system:${String(i)}`,
      group: 'system',
      kind: 'system',
      label: systemLabel(b.text, i),
      source: systemSource(b.text, i),
      text,
      tokens: estimateTokens(text),
      edited: o !== undefined,
      removed: o === null,
      editable: true,
    };
  });
  const tools = s.tools.map((t): ContextItem => {
    const o = s.overrides.tools[t.name];
    const description = typeof o === 'string' ? o : t.description;
    return {
      id: `tool:${t.name}`,
      group: 'tools',
      kind: 'tool',
      label: t.name,
      source: toolSource(t.name),
      text: description,
      tokens: estimateTokens(JSON.stringify({ ...t, description })),
      edited: o !== undefined,
      removed: o === null,
      editable: true,
    };
  });
  const names = toolNames(s.history);
  const chat = s.history.flatMap((m, mi) =>
    m.content.map((b, bi): ContextItem => {
      const text = blockText(b);
      return {
        id: `chat:${String(mi)}:${String(bi)}`,
        group: 'chat',
        kind: b.type,
        role: m.role,
        label: blockLabel(b, m.role, names),
        text,
        tokens: estimateTokens(text),
        edited: false,
        removed: false,
        editable: b.type !== 'image' && b.type !== 'opaque',
      };
    }),
  );
  const notes = (s.overrides.notes ?? []).map((n): ContextItem => ({
    id: `note:${n.id}`,
    group: 'notes',
    kind: 'note',
    source: n.pinned ? 'Pinned from chat' : 'Your note',
    label: preview(n.text) || '(empty note)',
    text: n.text,
    tokens: estimateTokens(noteBlock(n)),
    edited: false,
    removed: false,
    editable: true,
  }));
  return [...system, ...tools, ...notes, ...chat];
}

/** Total tokens of what is actually sent (hidden items left out). */
export function contextTotal(items: readonly ContextItem[]): number {
  return items.filter((i) => !i.removed).reduce((n, i) => n + i.tokens, 0);
}

/** What the next request sends: originals with overrides applied and hidden items left out. */
export function applyContext(s: ContextState): { system: SystemBlock[]; tools: ToolSpec[] } {
  const system = s.system.flatMap((b, i) => {
    const o = s.overrides.system[i];
    if (o === null) return [];
    return [typeof o === 'string' ? { ...b, text: o } : b];
  });
  const tools = s.tools.flatMap((t) => {
    const o = s.overrides.tools[t.name];
    if (o === null) return [];
    return [typeof o === 'string' ? { ...t, description: o } : t];
  });
  const notes = (s.overrides.notes ?? []).map((n) => ({ text: noteBlock(n) }));
  return { system: [...system, ...notes], tools };
}

type Ref =
  | { group: 'system'; index: number }
  | { group: 'tools'; name: string }
  | { group: 'notes'; id: string }
  | { group: 'chat'; message: number; block: number };

function parseId(s: ContextState, id: string): Ref {
  const missing = new Error(`no context item "${id}"`);
  const [group, a, b] = id.split(':');
  if (group === 'system') {
    const index = Number(a);
    if (!Number.isInteger(index) || !s.system[index]) throw missing;
    return { group, index };
  }
  if (group === 'tool') {
    const name = id.slice('tool:'.length);
    if (!s.tools.some((t) => t.name === name)) throw missing;
    return { group: 'tools', name };
  }
  if (group === 'note') {
    const noteId = id.slice('note:'.length);
    if (!(s.overrides.notes ?? []).some((n) => n.id === noteId)) throw missing;
    return { group: 'notes', id: noteId };
  }
  if (group === 'chat') {
    const message = Number(a);
    const block = Number(b);
    if (!Number.isInteger(message) || !Number.isInteger(block)) throw missing;
    if (!s.history[message]?.content[block]) throw missing;
    return { group, message, block };
  }
  throw missing;
}

function editBlock(b: ContentBlock, text: string): ContentBlock {
  switch (b.type) {
    case 'text':
      return { ...b, text };
    case 'tool_result':
      return { ...b, content: text };
    case 'tool_use': {
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        throw new Error("a tool call's input must be valid JSON");
      }
      return { ...b, input };
    }
    default:
      throw new Error(`a ${b.type} block can't be edited, only deleted`);
  }
}

const withNotes = (s: ContextState, notes: readonly ContextNote[]): ContextState => ({
  ...s,
  overrides: { ...s.overrides, notes },
});

export function updateContextItem(s: ContextState, id: string, text: string): ContextState {
  const ref = parseId(s, id);
  if (ref.group === 'notes')
    return withNotes(
      s,
      (s.overrides.notes ?? []).map((n) => (n.id === ref.id ? { ...n, text } : n)),
    );
  if (ref.group === 'system')
    return {
      ...s,
      overrides: { ...s.overrides, system: { ...s.overrides.system, [ref.index]: text } },
    };
  if (ref.group === 'tools')
    return {
      ...s,
      overrides: { ...s.overrides, tools: { ...s.overrides.tools, [ref.name]: text } },
    };
  const history = s.history.map((m, mi) =>
    mi === ref.message
      ? { ...m, content: m.content.map((b, bi) => (bi === ref.block ? editBlock(b, text) : b)) }
      : m,
  );
  return { ...s, history };
}

/** Join neighbours with the same role (a deletion can leave two in a row). */
function mergeRoles(history: readonly Message[]): Message[] {
  return history.reduce<Message[]>((out, m) => {
    const last = out.at(-1);
    if (last?.role === m.role)
      return [...out.slice(0, -1), { ...last, content: [...last.content, ...m.content] }];
    return [...out, m];
  }, []);
}

export function deleteContextItem(s: ContextState, id: string): ContextState {
  const ref = parseId(s, id);
  if (ref.group === 'notes')
    return withNotes(
      s,
      (s.overrides.notes ?? []).filter((n) => n.id !== ref.id),
    );
  if (ref.group === 'system')
    return {
      ...s,
      overrides: { ...s.overrides, system: { ...s.overrides.system, [ref.index]: null } },
    };
  if (ref.group === 'tools')
    return {
      ...s,
      overrides: { ...s.overrides, tools: { ...s.overrides.tools, [ref.name]: null } },
    };
  const target = s.history[ref.message]?.content[ref.block];
  // A tool call and its result go together: providers reject one without the other.
  const callId =
    target?.type === 'tool_use'
      ? target.id
      : target?.type === 'tool_result'
        ? target.toolUseId
        : undefined;
  const keep = (b: ContentBlock, mi: number, bi: number): boolean => {
    if (mi === ref.message && bi === ref.block) return false;
    if (callId === undefined) return true;
    return !(
      (b.type === 'tool_use' && b.id === callId) ||
      (b.type === 'tool_result' && b.toolUseId === callId)
    );
  };
  const history = s.history
    .map((m, mi) => ({ ...m, content: m.content.filter((b, bi) => keep(b, mi, bi)) }))
    .filter((m) => m.content.length > 0);
  return { ...s, history: mergeRoles(history) };
}

const nextNoteId = (s: ContextState): string =>
  String(1 + Math.max(0, ...(s.overrides.notes ?? []).map((n) => Number(n.id) || 0)));

/** Add a note of the person's own: it goes out with every request until deleted. */
export function addContextNote(s: ContextState, text: string, pinned = false): ContextState {
  if (!text.trim()) throw new Error('a note needs some text');
  return withNotes(s, [...(s.overrides.notes ?? []), { id: nextNoteId(s), text, pinned }]);
}

/** Pin a chat item: keep a copy as a note, so trimming and compaction can't drop it. */
export function pinContextItem(s: ContextState, id: string): ContextState {
  const item = listContext(s).find((i) => i.id === id);
  if (!item) throw new Error(`no context item "${id}"`);
  if (item.group !== 'chat')
    throw new Error('only chat items can be pinned; the rest is always sent');
  return addContextNote(s, `${item.label}\n\n${item.text}`, true);
}

/** Bring back one hidden or edited system block or tool. */
export function restoreContextItem(s: ContextState, id: string): ContextState {
  const ref = parseId(s, id);
  if (ref.group === 'system') {
    const system = Object.fromEntries(
      Object.entries(s.overrides.system).filter(([k]) => Number(k) !== ref.index),
    );
    return { ...s, overrides: { ...s.overrides, system } };
  }
  if (ref.group === 'tools') {
    const tools = Object.fromEntries(
      Object.entries(s.overrides.tools).filter(([k]) => k !== ref.name),
    );
    return { ...s, overrides: { ...s.overrides, tools } };
  }
  throw new Error('only system blocks and tools have a default to restore');
}
