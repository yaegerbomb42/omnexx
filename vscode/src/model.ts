/**
 * The parts of the extension that don't need VS Code: parsing what the CLI prints, picking the
 * runs that belong to the open folders, and building command lines. Unit-tested from the root.
 */

export interface RunRow {
  runId: string;
  /** The goal's first line (omnexx 0.11.4+). */
  goal?: string | undefined;
  status: string;
  phase: string;
  cycle: number;
  task?: string | undefined;
  repoName: string;
  repoRoot: string;
  worktree: string;
  branch: string;
  startedAt: number;
  usd: number;
  commits: number;
  supervisorAlive: boolean;
  /** From omnexx 0.8: working, quiet, waiting, stalled, dead or ended. */
  health?: string | undefined;
}

export interface PlanNodeRow {
  id: string;
  type: 'milestone' | 'task';
  parentId: string | null;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'parked';
  attempts: number;
  parkedReason?: string | undefined;
}

export interface PlanView {
  goal: string;
  currentTask: string | null;
  nodes: PlanNodeRow[];
}

/** Statuses in which a supervisor is (or should be) working on the run. */
const LIVE = new Set(['planned', 'running', 'paused']);

const NODE_STATUSES = new Set(['todo', 'doing', 'done', 'parked']);

/** A duration the CLI's `--for` accepts, e.g. `45m`, `8h`, `2d`, `1h30m`. */
const DURATION = /^(\d+(\.\d+)?(m|h|d))+$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== 'string') throw new Error(`expected "${k}" to be a string`);
  return v;
}

function num(r: Record<string, unknown>, k: string): number {
  const v = r[k];
  if (typeof v !== 'number') throw new Error(`expected "${k}" to be a number`);
  return v;
}

function optStr(r: Record<string, unknown>, k: string): string | undefined {
  const v = r[k];
  return typeof v === 'string' ? v : undefined;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `omnexx printed something that isn't JSON for ${what}; is it older than 0.5.0?`,
    );
  }
}

/** Parse `omnexx runs --json`. Throws with a readable message when the shape is wrong. */
export function parseRuns(text: string): RunRow[] {
  const data = parseJson(text, 'runs --json');
  if (!Array.isArray(data)) throw new Error('expected a list of runs');
  return data.map((x): RunRow => {
    if (!isRecord(x)) throw new Error('expected each run to be an object');
    return {
      runId: str(x, 'runId'),
      goal: optStr(x, 'goal'),
      status: str(x, 'status'),
      phase: str(x, 'phase'),
      cycle: num(x, 'cycle'),
      task: optStr(x, 'task'),
      repoName: str(x, 'repoName'),
      repoRoot: str(x, 'repoRoot'),
      worktree: str(x, 'worktree'),
      branch: str(x, 'branch'),
      startedAt: num(x, 'startedAt'),
      usd: num(x, 'usd'),
      commits: num(x, 'commits'),
      supervisorAlive: x.supervisorAlive === true,
      health: optStr(x, 'health'),
    };
  });
}

export interface ChatRow {
  id: string;
  title: string;
  savedAt: number;
  messages: number;
}

/** Parse `omnexx chats --json`. */
export function parseChats(text: string): ChatRow[] {
  const data = parseJson(text, 'chats --json');
  if (!Array.isArray(data)) throw new Error('expected a list of chats');
  return data.map((x): ChatRow => {
    if (!isRecord(x)) throw new Error('expected each chat to be an object');
    return {
      id: str(x, 'id'),
      title: str(x, 'title'),
      savedAt: num(x, 'savedAt'),
      messages: num(x, 'messages'),
    };
  });
}

export type HistoryGroup = 'Today' | 'Yesterday' | 'Earlier';
export const HISTORY_GROUPS: readonly HistoryGroup[] = ['Today', 'Yesterday', 'Earlier'];

/** Which History heading a time falls under, by local calendar day. */
export function historyGroup(at: number, now: number): HistoryGroup {
  const day = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = day(now);
  if (day(at) >= today) return 'Today';
  const yesterday = day(today - 1);
  return day(at) >= yesterday ? 'Yesterday' : 'Earlier';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function relativeTime(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${String(Math.floor(ago / MINUTE))}m ago`;
  if (ago < DAY) return `${String(Math.floor(ago / HOUR))}h ago`;
  if (ago < 7 * DAY) return `${String(Math.floor(ago / DAY))}d ago`;
  return new Date(at).toLocaleDateString();
}

/** A run's History name: its goal, else the repo and id. */
export function runTitle(run: RunRow): string {
  const goal = run.goal?.trim();
  if (!goal) return `${run.repoName} · ${run.runId}`;
  const short = goal.length > 60 ? `${goal.slice(0, 59).trimEnd()}…` : goal;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** Parse `omnexx plan --json`. */
export function parsePlan(text: string): PlanView {
  const data = parseJson(text, 'plan --json');
  if (!isRecord(data) || !Array.isArray(data.nodes)) throw new Error('expected a plan object');
  const nodes = data.nodes.map((x): PlanNodeRow => {
    if (!isRecord(x)) throw new Error('expected each plan node to be an object');
    const status = str(x, 'status');
    if (!NODE_STATUSES.has(status)) throw new Error(`unknown task status "${status}"`);
    return {
      id: str(x, 'id'),
      type: x.type === 'milestone' ? 'milestone' : 'task',
      parentId: typeof x.parentId === 'string' ? x.parentId : null,
      title: str(x, 'title'),
      status: status as PlanNodeRow['status'],
      attempts: typeof x.attempts === 'number' ? x.attempts : 0,
      parkedReason: optStr(x, 'parkedReason'),
    };
  });
  return {
    goal: typeof data.goal === 'string' ? data.goal : '',
    currentTask: typeof data.currentTask === 'string' ? data.currentTask : null,
    nodes,
  };
}

function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  const norm = (p: string): string => {
    const trimmed = p.replace(/[\\/]+$/, '');
    return caseInsensitive ? trimmed.toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

/**
 * The runs started from one of the open folders (or their run worktrees), newest first.
 * With no folders open, or `all`, every run.
 */
export function runsForFolders(
  runs: readonly RunRow[],
  folders: readonly string[],
  opts: { all?: boolean; caseInsensitive?: boolean } = {},
): RunRow[] {
  const ci = opts.caseInsensitive ?? false;
  const mine =
    opts.all || folders.length === 0
      ? runs
      : runs.filter((r) =>
          folders.some((f) => samePath(r.repoRoot, f, ci) || samePath(r.worktree, f, ci)),
        );
  return [...mine].sort((a, b) => b.startedAt - a.startedAt);
}

export function isActive(run: RunRow): boolean {
  return run.supervisorAlive && LIVE.has(run.status);
}

/** One line under the run's name in the sidebar. */
const HEALTH_NOTE: Record<string, string> = {
  quiet: 'quiet for 15m+',
  waiting: 'waiting on providers',
  stalled: 'stalled: no heartbeat',
  dead: 'supervisor not running',
};

/** Runs that need a hand: resume (restarts the supervisor) or stop. */
export function needsFix(run: RunRow): boolean {
  return run.health === 'dead' || run.health === 'stalled';
}

/**
 * Runs that just finished: in the current listing but not in the previous one (started and
 * finished between refreshes), or previously active and now finished. Runs that vanished from
 * the listing are ignored; runs that were already finished in the previous listing are not counted.
 */
export function newlyFinishedRuns(
  currentRuns: readonly RunRow[],
  previousRuns: ReadonlyMap<string, RunRow>,
): RunRow[] {
  const result: RunRow[] = [];
  for (const run of currentRuns) {
    if (isActive(run)) continue;
    const prev = previousRuns.get(run.runId);
    if (!prev || isActive(prev)) result.push(run);
  }
  return result;
}

export function describeRun(run: RunRow): string {
  const note = run.health ? HEALTH_NOTE[run.health] : undefined;
  if (note) return `${note} · cycle ${String(run.cycle)} · ${String(run.commits)} commits`;
  const where = run.task ? `${run.phase} ${run.task}` : run.phase;
  const state = isActive(run) ? where : run.status;
  return `${state} · cycle ${run.cycle} · ${run.commits} commits · $${run.usd.toFixed(2)}`;
}

/** Milestones in plan order, or a milestone's tasks. */
export function childrenOf(plan: PlanView, parentId: string | null): PlanNodeRow[] {
  return plan.nodes.filter((n) => n.parentId === parentId);
}

export function progressOf(plan: PlanView, milestoneId: string): { done: number; total: number } {
  const tasks = childrenOf(plan, milestoneId);
  return { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length };
}

/** `undefined` when valid, otherwise what to tell the user. */
export function validateDuration(text: string): string | undefined {
  return DURATION.test(text.trim()) ? undefined : 'Use a duration like 45m, 8h, 2d or 1h30m.';
}

export interface RunOptions {
  goal: string;
  forDuration?: string | undefined;
  gate?: string | undefined;
}

/** Arguments for `omnexx run`: always detached, so closing the terminal doesn't stop it. */
export function runArgs(o: RunOptions): string[] {
  const goal = o.goal.trim();
  if (!goal) throw new Error('A run needs a goal.');
  const args = ['run', '--detach'];
  if (o.forDuration) {
    const problem = validateDuration(o.forDuration);
    if (problem) throw new Error(problem);
    args.push('--for', o.forDuration.trim());
  }
  if (o.gate?.trim()) args.push('--gate', o.gate.trim());
  args.push(goal);
  return args;
}

/** Compare dotted versions ("0.10.0" > "0.9.3"); a pre-release suffix is ignored. -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      ?.split('.')
      .map((n) => Number.parseInt(n, 10) || 0) ?? [];
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** A version printed by `omnexx --version`, or undefined when the output isn't one. */
export function parseVersion(out: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)\b/.exec(out)?.[1];
}
