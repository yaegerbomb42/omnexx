import { fmtTokens as formatTokensShort } from '../telemetry/humanize.js';
import {
  addContextNote,
  clearContextHistory,
  contextTotal,
  pinContextItem,
  restoreContextItem,
  type ContextGroup,
  type ContextItem,
  type ContextState,
} from './context-edit.js';

/**
 * Changes the context inspector can make, shared by the VS Code panel (chat-server) and the
 * terminal `/context` command, plus the terminal's text view of the context.
 */

export type ContextChange =
  | { op: 'edit'; id: string; text: string }
  | { op: 'delete'; id: string }
  | { op: 'reset' }
  | { op: 'add'; text: string }
  | { op: 'pin'; id: string }
  | { op: 'restore'; id: string }
  | { op: 'clearChat' };

type PureChange = Extract<ContextChange, { op: 'add' | 'pin' | 'restore' | 'clearChat' }>;

/** The pure state change for ops that don't have their own CodeChat method. */
export function contextTransform(change: PureChange): (s: ContextState) => ContextState {
  switch (change.op) {
    case 'add':
      return (s) => addContextNote(s, change.text);
    case 'pin':
      return (s) => pinContextItem(s, change.id);
    case 'restore':
      return (s) => restoreContextItem(s, change.id);
    case 'clearChat':
      return (s) => clearContextHistory(s);
  }
}

const GROUP_TITLES: Record<ContextGroup, string> = {
  system: 'System prompt',
  tools: 'Tools',
  notes: 'Your notes',
  chat: 'Chat history',
};

const BAR_WIDTH = 30;

/** A text bar: `[#########-----] 12k / 120k (10%)`. */
export function budgetBar(used: number, budget: number): string {
  if (budget <= 0) return `${formatTokensShort(used)} tokens`;
  const share = Math.min(1, used / budget);
  const filled = Math.round(share * BAR_WIDTH);
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}] ${formatTokensShort(used)} / ${formatTokensShort(budget)} (${String(Math.round((used / budget) * 100))}%)`;
}

/** The `/context` listing: a budget bar, then every item by group with id, tokens and source. */
export function renderContext(items: readonly ContextItem[], budget: number): string {
  if (!items.length) return 'No context yet: send a message first.';
  const lines = [`Context next turn ${budgetBar(contextTotal(items), budget)}`];
  for (const group of Object.keys(GROUP_TITLES) as ContextGroup[]) {
    const list = items.filter((i) => i.group === group);
    if (!list.length) continue;
    lines.push('', `${GROUP_TITLES[group]} (${formatTokensShort(contextTotal(list))})`);
    for (const i of list) {
      const flags = i.removed ? ' [hidden]' : i.edited ? ' [edited]' : '';
      const src = i.source ? `  · ${i.source}` : '';
      lines.push(
        `  ${i.id.padEnd(14)} ${formatTokensShort(i.tokens).padStart(6)}  ${i.label}${flags}${src}`,
      );
    }
  }
  lines.push(
    '',
    '/context show <id> · edit <id> <text> · delete|hide <id> · restore <id> · pin <id> · note <text> · reset',
  );
  return lines.join('\n');
}

export type ContextCommand =
  { kind: 'list' } | { kind: 'show'; id: string } | { kind: 'change'; change: ContextChange };

const USAGE =
  'usage: /context [show|edit|delete|hide|restore|pin|note|reset] (see /context for the list)';

/** Parse what follows `/context`. */
export function parseContextCommand(args: readonly string[]): ContextCommand {
  const [verb, id, ...rest] = args;
  if (!verb || verb === 'list') return { kind: 'list' };
  if (verb === 'reset') return { kind: 'change', change: { op: 'reset' } };
  if (verb === 'note' || verb === 'add') {
    const text = [id, ...rest].filter(Boolean).join(' ');
    if (!text.trim()) throw new Error('usage: /context note <text>');
    return { kind: 'change', change: { op: 'add', text } };
  }
  if (!id) throw new Error(USAGE);
  switch (verb) {
    case 'show':
      return { kind: 'show', id };
    case 'edit':
      return { kind: 'change', change: { op: 'edit', id, text: rest.join(' ') } };
    case 'delete':
    case 'hide':
      return { kind: 'change', change: { op: 'delete', id } };
    case 'restore':
      return { kind: 'change', change: { op: 'restore', id } };
    case 'pin':
      return { kind: 'change', change: { op: 'pin', id } };
    default:
      throw new Error(USAGE);
  }
}
