import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runsCommand } from '../../../src/cli/commands/inspect.js';
import { resumeSummary } from '../../../src/cli/run-deps.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { RunStore } from '../../../src/core/run-store.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface RunRowJson {
  runId: string;
  status: string;
  mode: string;
  progress: { done: number; tasks: number };
  lastCheckpoint: { milestoneId: string; tag: string; at: number } | null;
}

async function setupRun(status: string) {
  const home = await mkdtemp(join(tmpdir(), 'omnexx-resume-'));
  dirs.push(home);
  const out = new PassThrough();
  let text = '';
  out.on('data', (c: { toString(): string }) => {
    text += String(c);
  });
  const io = {
    stdout: out,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    env: { OMNEXX_HOME: home, OMNEXX_CONFIG_HOME: home },
    cwd: home,
    isTTY: false,
  };
  const paths = resolvePaths(io.env);
  const store = new RunStore(paths, 'r_abc');
  await store.init();
  await store.writeGoal('# fix the flaky test\n');
  await store.writeState({
    version: 1,
    runId: 'r_abc',
    repoRoot: home,
    repoName: 'demo',
    worktree: home,
    branch: 'main',
    startRef: 'a'.repeat(40),
    lastGreen: 'b'.repeat(40),
    greenHistory: [],
    phase: 'act',
    status: status as 'paused' | 'finished',
    statusReason: status === 'paused' ? 'user pause' : 'done',
    cycle: 4,
    taskId: undefined,
    startedAt: 1000,
    updatedAt: 2000,
    activeMs: 0,
    goalHash: 'hash',
    setupDone: true,
    spend: {
      usd: 1.23,
      tokens: { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      turns: 0,
      llmCalls: 0,
      byModel: {},
      byProvider: {},
    },
    acceptedCommits: 2,
    beyondRounds: 0,
    idleRounds: 0,
    evidenceShown: [],
    auditRounds: 0,
    rejectedCycles: 0,
    lastProgressAt: undefined,
    lastProgressCycle: 0,
    recoveries: 0,
    warned: [],
    cycleTokens: [],
    recordedCycle: 0,
    checkpoints: [
      { milestoneId: 'M3', sha: 'c'.repeat(40), tag: 'foundation', at: 1500, usd: 0.5, tests: 12 },
    ],
    disabledWorkers: [],
    noChecks: false,
    writing: false,
    executionMode: 'extreme',
    workDomain: 'swe',
    budgetExhausted: false,
    providersUnavailable: undefined,
    dailyCapHit: false,
    spendLedger: [],
  });
  return { io, getOut: () => text, store };
}

describe('resume-from-checkpoint UX', () => {
  it('plain `runs` lists mode and the last checkpoint of an interrupted run', async () => {
    const { io, getOut } = await setupRun('paused');
    await runsCommand(io, false);
    expect(getOut()).toContain('r_abc');
    expect(getOut()).toContain('paused');
    expect(getOut()).toContain('extreme');
    expect(getOut()).toContain('M3');
  });

  it('`runs --json` reports mode, progress and last checkpoint', async () => {
    const { io, getOut } = await setupRun('paused');
    await runsCommand(io, true);
    const rows = JSON.parse(getOut()) as RunRowJson[];
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.mode).toBe('extreme');
    expect(row.progress).toEqual({ done: 0, tasks: 0 });
    expect(row.lastCheckpoint).toEqual({
      milestoneId: 'M3',
      tag: 'foundation',
      at: 1500,
    });
  });

  it('resumeSummary extracts mode, progress and last checkpoint from run state', async () => {
    const { store } = await setupRun('paused');
    const s = await store.readState();
    const summary = resumeSummary(s);
    expect(summary.mode).toBe('extreme');
    expect(summary.progress).toEqual({ done: 0, tasks: 0 });
    expect(summary.lastCheckpoint?.milestoneId).toBe('M3');
    expect(summary.lastCheckpoint?.tag).toBe('foundation');
  });
});
