import {
  CONTEXT_LABELS,
  contextBudget,
  fmtK,
  MAX_LEVEL,
  MAX_TOKEN_CHOICES,
  MIN_LEVEL,
  TASK_EFFORT_LABELS,
  TIME_CHOICES,
  TURN_EFFORT_LABELS,
  type AgentLevels,
} from '../core/agent-levels.js';

/**
 * The `/settings` panel's state and keys, kept pure so they are testable without a terminal:
 * Tab / Shift-Tab (or ↑↓) move between rows, ←/→ change the value, Enter saves, Esc cancels.
 * The last row is "ask at start": on the startup offer it reads "ask again next launch" /
 * "keep these, don't ask again".
 */

export const PANEL_ROWS = ['task', 'turn', 'context', 'time', 'tokens', 'ask'] as const;
export type PanelRow = (typeof PANEL_ROWS)[number];

export interface AgentPanelState {
  focus: number;
  levels: AgentLevels;
  askOnStart: boolean;
  /** Opened at launch (the offer), rather than by `/settings`. */
  startup: boolean;
}

export interface PanelKey {
  next?: boolean;
  prev?: boolean;
  left?: boolean;
  right?: boolean;
  enter?: boolean;
  escape?: boolean;
}

export type PanelResult =
  | { kind: 'open'; state: AgentPanelState }
  | { kind: 'save'; state: AgentPanelState }
  | { kind: 'cancel' };

const stepLevel = (v: number, d: number): number => Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, v + d));

/** Step through a list of choices, staying at the ends. */
function stepChoice<T>(list: readonly T[], v: T, d: number): T {
  const i = list.indexOf(v);
  const next = Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + d));
  return list[next] ?? v;
}

/** The nearest allowed output cap at or above `n`'s position. */
function stepTokens(v: number, d: number): number {
  const i = MAX_TOKEN_CHOICES.findIndex((c) => c >= v);
  const from = i < 0 ? MAX_TOKEN_CHOICES.length - 1 : i;
  const next = Math.min(MAX_TOKEN_CHOICES.length - 1, Math.max(0, from + d));
  return MAX_TOKEN_CHOICES[next] ?? v;
}

function change(s: AgentPanelState, d: number): AgentPanelState {
  const l = s.levels;
  switch (PANEL_ROWS[s.focus]) {
    case 'task':
      return { ...s, levels: { ...l, taskEffort: stepLevel(l.taskEffort, d) } };
    case 'turn':
      return { ...s, levels: { ...l, turnEffort: stepLevel(l.turnEffort, d) } };
    case 'context':
      return { ...s, levels: { ...l, contextLevel: stepLevel(l.contextLevel, d) } };
    case 'time':
      return { ...s, levels: { ...l, time: stepChoice(TIME_CHOICES, l.time, d) } };
    case 'tokens':
      return { ...s, levels: { ...l, maxTokens: stepTokens(l.maxTokens, d) } };
    case 'ask':
      return { ...s, askOnStart: !s.askOnStart };
    default:
      return s;
  }
}

/** The keys ink reports, as far as the panel cares. */
export interface InkKeyLike {
  tab?: boolean;
  shift?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
}

/** Terminal keys → panel keys: Tab / ↓ next, Shift-Tab / ↑ previous, ←→ change, h/l too. */
export function agentPanelKeyOf(ch: string, key: InkKeyLike): PanelKey {
  if (key.escape) return { escape: true };
  if (key.return) return { enter: true };
  if ((key.tab && key.shift) || key.upArrow) return { prev: true };
  if (key.tab || key.downArrow) return { next: true };
  if (key.leftArrow || ch === 'h') return { left: true };
  if (key.rightArrow || ch === 'l') return { right: true };
  return {};
}

export function panelKey(s: AgentPanelState, k: PanelKey): PanelResult {
  if (k.escape) return { kind: 'cancel' };
  if (k.enter) return { kind: 'save', state: s };
  const rows = PANEL_ROWS.length;
  if (k.next) return { kind: 'open', state: { ...s, focus: (s.focus + 1) % rows } };
  if (k.prev) return { kind: 'open', state: { ...s, focus: (s.focus + rows - 1) % rows } };
  if (k.left) return { kind: 'open', state: change(s, -1) };
  if (k.right) return { kind: 'open', state: change(s, 1) };
  return { kind: 'open', state: s };
}

export interface PanelLine {
  row: PanelRow;
  name: string;
  /** A ten-cell bar for levels, empty for choices. */
  bar: string;
  /** "3 · small focused change, light planning". */
  value: string;
}

const BAR_CELLS = 10;
const bar = (n: number, of: number): string => {
  const filled = Math.round((n / of) * BAR_CELLS);
  return '■'.repeat(filled) + '·'.repeat(BAR_CELLS - filled);
};

const label = (table: readonly string[], n: number): string => table[n - 1] ?? '';

/** Every row, as the panel shows it. */
export function panelLines(s: AgentPanelState): PanelLine[] {
  const l = s.levels;
  const timeIndex = TIME_CHOICES.indexOf(l.time) + 1;
  const tokenIndex = MAX_TOKEN_CHOICES.findIndex((c) => c >= l.maxTokens) + 1;
  return [
    {
      row: 'task',
      name: 'effort per task',
      bar: bar(l.taskEffort, MAX_LEVEL),
      value: `${String(l.taskEffort)} · ${label(TASK_EFFORT_LABELS, l.taskEffort)}`,
    },
    {
      row: 'turn',
      name: 'effort per turn',
      bar: bar(l.turnEffort, MAX_LEVEL),
      value: `${String(l.turnEffort)} · ${label(TURN_EFFORT_LABELS, l.turnEffort)}`,
    },
    {
      row: 'context',
      name: 'context',
      bar: bar(l.contextLevel, MAX_LEVEL),
      value: `${fmtK(contextBudget(l.contextLevel))} · ${label(CONTEXT_LABELS, l.contextLevel)}`,
    },
    {
      row: 'time',
      name: 'time on task',
      bar: bar(timeIndex, TIME_CHOICES.length),
      value: l.time === 'unlimited' ? 'unlimited' : l.time,
    },
    {
      row: 'tokens',
      name: 'max reply length',
      bar: bar(tokenIndex, MAX_TOKEN_CHOICES.length),
      value: fmtK(l.maxTokens),
    },
    {
      row: 'ask',
      name: 'at start',
      bar: '',
      value: s.askOnStart ? 'ask again next launch' : "keep these, don't ask again",
    },
  ];
}
