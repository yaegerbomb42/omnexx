import { describe, expect, it } from 'vitest';
import {
  childrenOf,
  describeRun,
  isActive,
  parsePlan,
  parseRuns,
  progressOf,
  runArgs,
  runsForFolders,
  validateDuration,
  type RunRow,
} from '../../vscode/src/model.js';

const row = (over: Partial<RunRow> = {}): RunRow => ({
  runId: 'r_1',
  status: 'running',
  phase: 'act',
  cycle: 3,
  task: 'M1.T02',
  repoName: 'app',
  repoRoot: '/work/app',
  worktree: '/home/u/.omnexx/worktrees/r_1',
  branch: 'omnexx/r_1',
  startedAt: 1,
  usd: 0.5,
  commits: 2,
  supervisorAlive: true,
  ...over,
});

describe('parseRuns', () => {
  it('reads the rows omnexx runs --json prints', () => {
    const runs = parseRuns(JSON.stringify([{ ...row(), extra: 'ignored' }]));
    expect(runs).toEqual([row()]);
  });

  it('treats a missing task and supervisor flag as absent', () => {
    const rest: Record<string, unknown> = { ...row() };
    delete rest.task;
    delete rest.supervisorAlive;
    expect(parseRuns(JSON.stringify([rest]))[0]).toMatchObject({
      task: undefined,
      supervisorAlive: false,
    });
  });

  it('explains non-JSON output (an old CLI) and wrong shapes', () => {
    expect(() => parseRuns('r_1  finished')).toThrow(/isn't JSON/);
    expect(() => parseRuns('{}')).toThrow(/list of runs/);
    expect(() => parseRuns('[1]')).toThrow(/object/);
    expect(() => parseRuns(JSON.stringify([{ ...row(), cycle: '3' }]))).toThrow(/"cycle"/);
    expect(() => parseRuns(JSON.stringify([{ ...row(), runId: 7 }]))).toThrow(/"runId"/);
  });
});

describe('parsePlan', () => {
  const plan = {
    goal: 'ship it',
    currentTask: 'M1.T02',
    nodes: [
      { id: 'M1', type: 'milestone', parentId: null, title: 'First', status: 'doing', attempts: 0 },
      { id: 'M1.T01', type: 'task', parentId: 'M1', title: 'a', status: 'done', attempts: 1 },
      { id: 'M1.T02', type: 'task', parentId: 'M1', title: 'b', status: 'doing', attempts: 2 },
      {
        id: 'M2',
        type: 'milestone',
        parentId: null,
        title: 'Second',
        status: 'parked',
        attempts: 0,
        parkedReason: 'blocked',
      },
    ],
  };

  it('reads the plan, groups tasks under milestones and counts progress', () => {
    const p = parsePlan(JSON.stringify(plan));
    expect(p.goal).toBe('ship it');
    expect(p.currentTask).toBe('M1.T02');
    expect(childrenOf(p, null).map((n) => n.id)).toEqual(['M1', 'M2']);
    expect(childrenOf(p, 'M1').map((n) => n.id)).toEqual(['M1.T01', 'M1.T02']);
    expect(progressOf(p, 'M1')).toEqual({ done: 1, total: 2 });
    expect(progressOf(p, 'M2')).toEqual({ done: 0, total: 0 });
    expect(p.nodes[3]?.parkedReason).toBe('blocked');
  });

  it('fills defaults for an empty plan and rejects bad input', () => {
    expect(parsePlan('{"nodes":[]}')).toEqual({ goal: '', currentTask: null, nodes: [] });
    expect(() => parsePlan('[]')).toThrow(/plan object/);
    expect(() => parsePlan('{"nodes":[null]}')).toThrow(/object/);
    expect(() =>
      parsePlan(JSON.stringify({ nodes: [{ ...plan.nodes[0], status: 'weird' }] })),
    ).toThrow(/unknown task status "weird"/);
  });
});

describe('runsForFolders', () => {
  const a = row({ runId: 'a', repoRoot: '/work/app', startedAt: 1 });
  const b = row({ runId: 'b', repoRoot: '/work/other', startedAt: 3 });
  const c = row({ runId: 'c', repoRoot: '/work/app', startedAt: 2 });

  it('keeps runs for the open folders, newest first', () => {
    expect(runsForFolders([a, b, c], ['/work/app/']).map((r) => r.runId)).toEqual(['c', 'a']);
  });

  it('matches a folder that is the run worktree itself', () => {
    expect(runsForFolders([a, b], ['/home/u/.omnexx/worktrees/r_1'])).toHaveLength(2);
  });

  it('shows everything with no folder open or when asked', () => {
    expect(runsForFolders([a, b, c], []).map((r) => r.runId)).toEqual(['b', 'c', 'a']);
    expect(runsForFolders([a, b], ['/nowhere'], { all: true })).toHaveLength(2);
  });

  it('compares case-insensitively when the file system does', () => {
    const win = row({ repoRoot: 'C:\\Work\\App' });
    expect(runsForFolders([win], ['c:\\work\\app'])).toHaveLength(0);
    expect(runsForFolders([win], ['c:\\work\\app\\'], { caseInsensitive: true })).toHaveLength(1);
  });
});

describe('describeRun and isActive', () => {
  it('shows the phase and task while a supervisor works on it', () => {
    expect(isActive(row())).toBe(true);
    expect(describeRun(row())).toBe('act M1.T02 · cycle 3 · 2 commits · $0.50');
    expect(describeRun(row({ task: undefined }))).toMatch(/^act · cycle/);
  });

  it('shows the status once the run ended or its supervisor died', () => {
    expect(isActive(row({ status: 'finished' }))).toBe(false);
    expect(isActive(row({ supervisorAlive: false }))).toBe(false);
    expect(describeRun(row({ status: 'user-stop' }))).toMatch(/^user-stop · cycle 3/);
  });
});

describe('runArgs and validateDuration', () => {
  it('builds a detached run, with --for and --gate when given', () => {
    expect(runArgs({ goal: ' fix tests ' })).toEqual(['run', '--detach', 'fix tests']);
    expect(runArgs({ goal: 'improve', forDuration: '8h', gate: 'npm test' })).toEqual([
      'run',
      '--detach',
      '--for',
      '8h',
      '--gate',
      'npm test',
      'improve',
    ]);
    expect(runArgs({ goal: 'x', gate: '  ' })).toEqual(['run', '--detach', 'x']);
  });

  it('refuses an empty goal or a bad duration', () => {
    expect(() => runArgs({ goal: '  ' })).toThrow(/needs a goal/);
    expect(() => runArgs({ goal: 'x', forDuration: 'forever' })).toThrow(/duration like/);
  });

  it('accepts the durations the CLI accepts', () => {
    for (const ok of ['45m', '8h', '2d', '1h30m', '1.5h'])
      expect(validateDuration(ok)).toBeUndefined();
    for (const bad of ['', '8', 'h', '8 hours', '30s']) expect(validateDuration(bad)).toBeDefined();
  });
});
