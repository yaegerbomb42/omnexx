/**
 * The five agent sliders and what each level means. Pure tables and functions: the config layer
 * (config/agent-settings.ts), the providers (reasoning effort), the prompts (effort brief), the
 * CLI `/settings` panel and the VS Code card all read from here, so a level means the same thing
 * everywhere.
 */

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 10;

/** Context budgets in tokens, one per context level (1 = bare, 10 = keep everything). */
export const CONTEXT_BUDGETS = [
  5_000, 10_000, 20_000, 40_000, 64_000, 96_000, 128_000, 200_000, 500_000, 1_000_000,
] as const;

/** Time choices: how long the person wants the agent on a task. */
export const TIME_CHOICES = ['5m', '15m', '30m', '1h', '2h', '4h', '8h', 'unlimited'] as const;
export type TimeChoice = (typeof TIME_CHOICES)[number];

/** Output caps per model call. */
export const MAX_TOKEN_CHOICES = [1_024, 2_048, 4_096, 8_192, 16_000, 32_000, 64_000] as const;

/** "Unlimited" time still needs a number for max_hours: a year. */
export const UNLIMITED_HOURS = 8_760;

export interface AgentLevels {
  /** 1 = quick MVP, 10 = build a monolith. */
  taskEffort: number;
  /** Thinking depth per model call. */
  turnEffort: number;
  /** Index into CONTEXT_BUDGETS, 1-based. */
  contextLevel: number;
  time: TimeChoice;
  /** Output cap per model call, in tokens. */
  maxTokens: number;
}

export const DEFAULT_LEVELS: AgentLevels = {
  taskEffort: 5,
  turnEffort: 5,
  contextLevel: 6,
  time: '2h',
  maxTokens: 16_000,
};

export const clampLevel = (n: number): number =>
  Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(Number.isFinite(n) ? n : MIN_LEVEL)));

/** Pick from a ten-entry table by a 1-based level. */
function at<T>(table: readonly T[], level: number): T {
  const v = table[clampLevel(level) - 1];
  if (v === undefined) throw new Error(`level table is missing level ${String(level)}`);
  return v;
}

// ---- Effort per task --------------------------------------------------------------------------

export const TASK_EFFORT_LABELS = [
  'quick MVP, easiest way that works',
  'minimal change, no extras',
  'small focused change, light planning',
  'solid change with basic tests',
  'balanced: plan briefly, test what you touch',
  'thorough: plan, test, handle edge cases',
  'broad: milestones, full tests, polish',
  'ambitious: deep analysis, wide scope',
  'very ambitious: hours of work, extend the scope',
  'monolith: build as much as it can',
] as const;

export interface TaskEffortProfile {
  /** [plan] loop_think_turns: turns the think step may explore. */
  thinkTurns: number;
  /** [plan] loop_rounds: execute-and-check passes per loop session. */
  rounds: number;
  /** [plan] loop_rethinks: re-thinks when stuck. */
  rethinks: number;
  /** [plan] mode: fast path, auto, or always plan milestones. */
  planMode: 'fast' | 'auto' | 'full';
  /** [plan] milestones cap; undefined lets the planner size the plan. */
  milestones: number | undefined;
}

const THINK_TURNS = [2, 3, 4, 6, 8, 10, 14, 18, 24, 32];
const ROUNDS = [2, 3, 4, 5, 6, 7, 9, 11, 14, 18];
const RETHINKS = [0, 0, 1, 1, 2, 2, 3, 3, 4, 5];
const MILESTONES = [1, 1, 2, 3, 4, 6, 8, undefined, undefined, undefined];
/** At or above this many hours, high effort plans milestones even below level 8. */
const LONG_RUN_HOURS = 4;
const FULL_PLAN_EFFORT = 8;
const LONG_RUN_FULL_PLAN_EFFORT = 6;
const FAST_PLAN_EFFORT = 3;

export function taskEffortProfile(level: number, hours: number): TaskEffortProfile {
  const l = clampLevel(level);
  const full = l >= FULL_PLAN_EFFORT || (l >= LONG_RUN_FULL_PLAN_EFFORT && hours >= LONG_RUN_HOURS);
  return {
    thinkTurns: at(THINK_TURNS, l),
    rounds: at(ROUNDS, l),
    rethinks: at(RETHINKS, l),
    planMode: full ? 'full' : l <= FAST_PLAN_EFFORT ? 'fast' : 'auto',
    milestones: MILESTONES[l - 1],
  };
}

/** What the agent is told its task-effort level means: scope, planning, testing, review. */
const SCOPE = [
  'Build the smallest thing that works. Take the easiest path; skip extras, polish and refactors.',
  'Make the minimal change the goal needs. No extras.',
  'Make a small, focused change. Touch only what the goal needs.',
  'Make a solid change: do it properly, but keep the scope to the goal.',
  'Balance speed and quality: do the goal well, fix what it obviously needs nearby.',
  'Be thorough: cover the edge cases and error paths the goal implies.',
  'Work broadly: deliver the goal complete and polished, in milestones.',
  'Be ambitious: go beyond the literal goal where it clearly helps the person.',
  'Be very ambitious: plan for hours of work and extend the scope to a full feature set.',
  'Build as big as you can: a complete, production-grade system around the goal, for hours.',
];
const PLANNING = [
  'Do not plan; start at once.',
  'Plan in one sentence, then start.',
  'Plan briefly: a few bullet points.',
  'Write a short plan before you start.',
  'Write a short plan with the risks you see.',
  'Analyse the code first, then write a step-by-step plan.',
  'Analyse in depth and plan in milestones, each with its own checks.',
  'Analyse in depth: alternatives, risks, a milestone plan with checks.',
  'Explore widely and write a detailed milestone plan before any edit.',
  'Explore everything relevant and write a full architecture and milestone plan first.',
];
const TESTING = [
  'Test only if it is free.',
  'Run the existing checks; add no tests.',
  'Add a test only for the main path.',
  'Add tests for what you change.',
  'Add tests for what you change and run them.',
  'Add tests for the edge cases too.',
  'Aim for full test coverage of the new code.',
  'Full tests, including integration tests where they fit.',
  'Full tests and review your own diff carefully before finishing.',
  'Full tests, a careful self-review, and docs for everything you add.',
];

export function taskEffortBrief(level: number): string {
  const l = clampLevel(level);
  return [
    `Effort per task: ${String(l)}/10 (${at(TASK_EFFORT_LABELS, l)}), set by the user.`,
    at(SCOPE, l),
    at(PLANNING, l),
    at(TESTING, l),
  ].join(' ');
}

// ---- Effort per turn --------------------------------------------------------------------------

export const TURN_EFFORT_LABELS = [
  'no extra thinking',
  'a glance',
  'light thought',
  'some thought',
  'balanced',
  'careful',
  'deliberate',
  'deep',
  'very deep',
  'maximum thinking',
] as const;

/** Thinking budget in tokens per call (Anthropic, Gemini); 0 turns thinking off. */
const THINKING_BUDGETS = [0, 1_024, 2_048, 4_096, 6_144, 8_192, 12_288, 16_384, 24_576, 32_000];

export const thinkingBudget = (level: number): number => at(THINKING_BUDGETS, level);

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

const LOW_EFFORT_MAX = 3;
const MEDIUM_EFFORT_MAX = 7;

/** OpenAI-style reasoning_effort for a turn-effort level. */
export function reasoningEffort(level: number): ReasoningEffort {
  const l = clampLevel(level);
  if (l === MIN_LEVEL) return 'minimal';
  if (l <= LOW_EFFORT_MAX) return 'low';
  if (l <= MEDIUM_EFFORT_MAX) return 'medium';
  return 'high';
}

// ---- Context level ----------------------------------------------------------------------------

export const contextBudget = (level: number): number => at(CONTEXT_BUDGETS, level);

export const CONTEXT_LABELS = [
  'bare: goal, last turn, tools',
  'goal and the last few turns',
  'small: recent turns, short notes',
  'compact working set',
  'standard',
  'roomy',
  'large',
  'very large',
  'huge: long sessions on big repos',
  'maximum: 1M-window models (Gemini, Claude, GPT-4.1)',
] as const;

export interface ContextProfile {
  /** Tokens: the hard cap, the budget clamped to the model's window. */
  budget: number;
  /** Tokens: fold (older turns into the working state) past this, FOLD_FRACTION of the budget. */
  compactAt: number;
  /** Tokens: clear old tool results past this. */
  clearAt: number;
  keepTurns: number;
  keepToolResults: number;
  progressTail: number;
  notesMaxTokens: number;
  repoMapMaxTokens: number;
  /** Low levels: send the codemap, lessons and role card only on request. */
  bare: boolean;
}

const KEEP_TURNS = [1, 2, 3, 4, 4, 5, 6, 8, 12, 20];
const KEEP_TOOL_RESULTS = [1, 2, 3, 4, 6, 6, 8, 10, 16, 24];
const PROGRESS_TAIL = [1, 2, 3, 4, 5, 5, 6, 8, 10, 15];
const CLEAR_FRACTION = 0.6;
/**
 * Fold near the budget, not at it: the fold call and the reply need room, and folding rewrites
 * the cached prefix, so it should happen rarely (see test/unit/agent/cost-sim.test.ts).
 */
export const FOLD_FRACTION = 0.85;
const NOTES_FRACTION = 0.05;
const REPO_MAP_FRACTION = 0.05;
const NOTES_CAP = 4_000;
const REPO_MAP_CAP = 12_000;
const MIN_SECTION_TOKENS = 200;
const BARE_MAX_LEVEL = 2;
/** Leave room for the reply and the system prompt inside the model's window. */
const WINDOW_FRACTION = 0.85;

/** The budget, clamped to the model's window when it is known. */
export function clampToWindow(budget: number, window: number | undefined): number {
  return window ? Math.min(budget, Math.floor(window * WINDOW_FRACTION)) : budget;
}

export function contextProfile(level: number, window?: number): ContextProfile {
  const l = clampLevel(level);
  const budget = clampToWindow(contextBudget(l), window);
  const share = (f: number, cap: number): number =>
    Math.max(MIN_SECTION_TOKENS, Math.min(cap, Math.floor(budget * f)));
  return {
    budget,
    compactAt: Math.floor(budget * FOLD_FRACTION),
    clearAt: Math.floor(budget * CLEAR_FRACTION),
    keepTurns: at(KEEP_TURNS, l),
    keepToolResults: at(KEEP_TOOL_RESULTS, l),
    progressTail: at(PROGRESS_TAIL, l),
    notesMaxTokens: share(NOTES_FRACTION, NOTES_CAP),
    repoMapMaxTokens: share(REPO_MAP_FRACTION, REPO_MAP_CAP),
    bare: l <= BARE_MAX_LEVEL,
  };
}

// ---- Time -------------------------------------------------------------------------------------

const TIME_HOURS: Record<TimeChoice, number> = {
  '5m': 5 / 60,
  '15m': 15 / 60,
  '30m': 0.5,
  '1h': 1,
  '2h': 2,
  '4h': 4,
  '8h': 8,
  unlimited: UNLIMITED_HOURS,
};

export const timeHours = (t: TimeChoice): number => TIME_HOURS[t];

export function timeBrief(t: TimeChoice): string {
  if (t === 'unlimited')
    return 'Time: no limit set by the user; take the time the effort level calls for.';
  return `Time: the user wants this done in about ${t}. Size the plan so the work fits that time; when it runs short, finish and verify what you have instead of starting more.`;
}

// ---- Labels and summaries ---------------------------------------------------------------------

export const isTimeChoice = (v: unknown): v is TimeChoice =>
  typeof v === 'string' && (TIME_CHOICES as readonly string[]).includes(v);

/** "64k", "500k", "5k", "1M". */
export const fmtK = (n: number): string =>
  n >= 1_000_000 ? `${String(Math.round(n / 100_000) / 10)}M` : `${String(Math.round(n / 1_000))}k`;

/** The status bar's compact summary: "effort 6/4 · ctx 64k · 30m". */
export function levelsSummary(l: AgentLevels): string {
  return `effort ${String(l.taskEffort)}/${String(l.turnEffort)} · ctx ${fmtK(contextBudget(l.contextLevel))} · ${l.time === 'unlimited' ? '∞' : l.time}`;
}

/** The whole brief the agent gets about the user's settings (volatile part of the prompt). */
export function agentBrief(l: AgentLevels): string {
  return `# Your settings\n\n${taskEffortBrief(l.taskEffort)}\n${timeBrief(l.time)}`;
}
