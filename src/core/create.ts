import { basename } from 'node:path';
import { createWorktree } from '../git/worktree.js';
import { repoRoot } from '../git/repo.js';
import { readRepoNotes } from './repo-memory.js';
import { worktreesDir, type OmnexxPaths } from './paths.js';
import { newRunId } from './run-id.js';
import { RunStore, type RunState } from './run-store.js';

export interface CreateRunOptions {
  paths: OmnexxPaths;
  cwd: string;
  goal: string;
  from?: string;
  runId?: string;
  now: number;
  noChecks?: boolean;
}

/** Create the run directory, the worktree on `omnexx/<runId>` and the initial state. */
export async function createRun(o: CreateRunOptions): Promise<RunStore> {
  const root = await repoRoot(o.cwd);
  const runId = o.runId ?? newRunId(new Date(o.now));
  const store = new RunStore(o.paths, runId);
  await store.init();
  const wt = await createWorktree(root, worktreesDir(o.paths), runId, o.from ?? 'HEAD');
  await store.writeGoal(o.goal);
  const goal = await store.readGoal();
  const state: RunState = {
    version: 1,
    runId,
    repoRoot: root,
    repoName: basename(root),
    worktree: wt.path,
    branch: wt.branch,
    startRef: wt.startRef,
    lastGreen: wt.startRef,
    greenHistory: [{ sha: wt.startRef, cycle: 0 }],
    phase: 'init',
    status: 'running',
    cycle: 0,
    startedAt: o.now,
    updatedAt: o.now,
    activeMs: 0,
    goalHash: goal.hash,
    setupDone: false,
    spend: {
      usd: 0,
      tokens: { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      turns: 0,
      llmCalls: 0,
      byModel: {},
      byProvider: {},
    },
    acceptedCommits: 0,
    beyondRounds: 0,
    idleRounds: 0,
    auditRounds: 0,
    rejectedCycles: 0,
    lastProgressAt: o.now,
    lastProgressCycle: 0,
    warned: [],
    recordedCycle: 0,
    checkpoints: [],
    disabledWorkers: [],
    noChecks: o.noChecks ?? false,
    budgetExhausted: false,
    spendLedger: [],
    dailyCapHit: false,
    cycleTokens: [],
  };
  await store.writeState(state);
  // Start from what earlier runs and chats learned about this repo.
  const known = await readRepoNotes(o.paths, root);
  if (known.length) await store.writeNotes(known);
  return store;
}
