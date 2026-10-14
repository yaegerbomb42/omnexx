import { estimateTokens } from '../core/tokens.js';
import type { ContentBlock, Message, SystemBlock, ToolSpec } from '../providers/types.js';

/**
 * The context inspector's model: everything a chat sends the model (system blocks, tool
 * definitions, the conversation) as a flat list of items the editor can show, edit and delete.
 * System and tool edits are overrides on top of the originals, so "restore defaults" just drops
 * them; conversation edits rewrite the history. Every function returns new values.
 */

export type ContextGroup = 'system' | 'tools' | 'chat';

export interface ContextItem {
  /** `system:<i>`, `tool:<name>` or `chat:<message>:<block>`. */
  id: string;
  group: ContextGroup;
  kind: 'system' | 'tool' | ContentBlock['type'];
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

/** Replacement text per system block / tool; null hides it. */
export interface ContextOverrides {
  readonly system: Readonly<Record<number, string | null>>;
  readonly tools: Readonly<Record<string, string | null>>;
}

export const EMPTY_OVERRIDES: ContextOverrides = { system: {}, tools: {} };

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
  return heading ? preview(heading) : i === 0 ? 'Instructions' : `System block ${String(i + 1)}`;
}

export function listContext(s: ContextState): ContextItem[] {
  const system = s.system.map((b, i): ContextItem => {
    const o = s.overrides.system[i];
    const text = typeof o === 'string' ? o : b.text;
    return {
      id: `system:${String(i)}`,
      group: 'system',
      kind: 'system',
      label: systemLabel(b.text, i),
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
  return [...system, ...tools, ...chat];
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
  return { system, tools };
}

type Ref =
  | { group: 'system'; index: number }
  | { group: 'tools'; name: string }
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

export function updateContextItem(s: ContextState, id: string, text: string): ContextState {
  const ref = parseId(s, id);
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
