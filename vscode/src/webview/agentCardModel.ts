/** The Agent card's values and labels, without the DOM (tested on its own). */

export interface AgentLevels {
  taskEffort: number;
  turnEffort: number;
  contextLevel: number;
  time: string;
  maxTokens: number;
}

export interface AgentMeta {
  task: string[];
  turn: string[];
  context: { tokens: number; label: string }[];
  time: string[];
  tokens: number[];
}

export type SliderId = 'taskEffort' | 'turnEffort' | 'contextLevel' | 'time' | 'maxTokens';

const LEVEL_STEPS = 10;

const k = (n: number): string => `${String(Math.round(n / 1_000))}k`;

/** The slider position (1-based) for a setting's value. */
export function position(id: SliderId, l: AgentLevels, meta: AgentMeta): number {
  if (id === 'time') return Math.max(0, meta.time.indexOf(l.time)) + 1;
  if (id === 'maxTokens') {
    const i = meta.tokens.findIndex((t) => t >= l.maxTokens);
    return (i < 0 ? meta.tokens.length - 1 : i) + 1;
  }
  return l[id];
}

/** How many positions a slider has. */
export function steps(id: SliderId, meta: AgentMeta): number {
  if (id === 'time') return meta.time.length;
  if (id === 'maxTokens') return meta.tokens.length;
  return LEVEL_STEPS;
}

/** The setting with a slider moved to `pos` (1-based); returns a new object. */
export function withPosition(
  id: SliderId,
  pos: number,
  l: AgentLevels,
  meta: AgentMeta,
): AgentLevels {
  if (id === 'time') return { ...l, time: meta.time[pos - 1] ?? l.time };
  if (id === 'maxTokens') return { ...l, maxTokens: meta.tokens[pos - 1] ?? l.maxTokens };
  return { ...l, [id]: pos };
}

/** "3 · small focused change, light planning", "64k · standard", "30m". */
export function meaning(id: SliderId, l: AgentLevels, meta: AgentMeta): string {
  switch (id) {
    case 'taskEffort':
      return `${String(l.taskEffort)} · ${meta.task[l.taskEffort - 1] ?? ''}`;
    case 'turnEffort':
      return `${String(l.turnEffort)} · ${meta.turn[l.turnEffort - 1] ?? ''}`;
    case 'contextLevel': {
      const c = meta.context[l.contextLevel - 1];
      return c ? `${k(c.tokens)} · ${c.label}` : '';
    }
    case 'time':
      return l.time;
    case 'maxTokens':
      return k(l.maxTokens);
  }
}

export interface Slider {
  id: SliderId;
  name: string;
  hint: string;
  prominent: boolean;
}

/** The card's sliders, with plain-English labels and a one-line hint each. */
export const SLIDERS: readonly Slider[] = [
  {
    id: 'taskEffort',
    name: 'Effort per task',
    hint: 'how much planning and checking a whole task gets',
    prominent: true,
  },
  {
    id: 'contextLevel',
    name: 'Memory (context)',
    hint: 'how much of the conversation and code the model keeps in view',
    prominent: true,
  },
  {
    id: 'turnEffort',
    name: 'Effort per turn',
    hint: 'how hard the model thinks before each reply',
    prominent: false,
  },
  {
    id: 'time',
    name: 'Time on task',
    hint: 'when a long run stops on its own',
    prominent: false,
  },
  {
    id: 'maxTokens',
    name: 'Max reply length',
    hint: 'how much the model can write per reply (output), not what it remembers',
    prominent: false,
  },
];
