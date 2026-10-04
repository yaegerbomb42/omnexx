import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { StateError } from '../errors.js';
import { readJson, readTextOr, writeFileAtomic, writeJsonAtomic } from './atomic.js';
import { notesSchema, renderNotes, type Note } from './notes.js';
import { runDir, runsDir, type OmnexxPaths } from './paths.js';
import { planSchema, type Plan } from './plan.js';

export const PHASES = [
  'init',
  'planning',
  'select',
  'act',
  'verify',
  'commit',
  'rollback',
  'record',
  'guard',
  'wrapup',
  'done',
] as const;
export type Phase = (typeof PHASES)[number];

export const RUN_STATUS = [
  'planned',
  'running',
  'paused',
  'finished',
  'needs-human',
  'budget-stop',
  'user-stop',
  'error',
] as const;
export type RunStatus = (typeof RUN_STATUS)[number];
export const TERMINAL: readonly RunStatus[] = [
  'planned',
  'finished',
  'needs-human',
  'budget-stop',
  'user-stop',
];

const gateSnapshotSchema = z.object({
  exitCode: z.number(),
  timedOut: z.boolean(),
  failureIds: z.array(z.string()),
  tests: z
    .object({ total: z.number(), passed: z.number(), failed: z.number(), skipped: z.number() })
    .optional(),
});
export type GateSnapshot = z.infer<typeof gateSnapshotSchema>;
export const baselineSchema = z.record(z.string(), gateSnapshotSchema);
export type Baseline = z.infer<typeof baselineSchema>;

export const tokenUsageSchema = z.object({
  uncached: z.number().default(0),
  cacheWrite: z.number().default(0),
  cacheRead: z.number().default(0),
  output: z.number().default(0),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

const pendingSchema = z.object({
  verdict: z.enum(['accept', 'reject']),
  taskId: z.string(),
  done: z.boolean(),
  reasons: z.array(z.string()),
  signature: z.string(),
  diffHash: z.string(),
  baseline: baselineSchema.optional(),
  summary: z.string(),
  /** What the model should see next attempt if this is rejected (failures, violations). */
  evidence: z.string().default(''),
  changedFiles: z.array(z.string()).default([]),
  diffStats: z
    .object({ files: z.number(), added: z.number(), removed: z.number() })
    .default({ files: 0, added: 0, removed: 0 }),
  stuck: z.array(z.string()).default([]),
  testsPassed: z.number().optional(),
  worker: z.string().optional(),
});
export type PendingVerdict = z.infer<typeof pendingSchema>;

export const stateSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  repoRoot: z.string(),
  repoName: z.string(),
  worktree: z.string(),
  branch: z.string(),
  startRef: z.string(),
  lastGreen: z.string(),
  greenHistory: z.array(z.object({ sha: z.string(), cycle: z.number() })).default([]),
  phase: z.enum(PHASES),
  status: z.enum(RUN_STATUS),
  statusReason: z.string().optional(),
  cycle: z.number().int().nonnegative(),
  taskId: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  /** Wall-clock already spent before the current supervisor started (resume keeps the clock honest). */
  activeMs: z.number().default(0),
  goalHash: z.string(),
  baseline: baselineSchema.optional(),
  setupDone: z.boolean().default(false),
  spend: z
    .object({
      usd: z.number().default(0),
      tokens: tokenUsageSchema.prefault({}),
      turns: z.number().default(0),
      llmCalls: z.number().default(0),
      byModel: z.record(z.string(), z.number()).default({}),
    })
    .prefault({}),
  acceptedCommits: z.number().default(0),
  rejectedCycles: z.number().default(0),
  lastProgressAt: z.number().optional(),
  lastProgressCycle: z.number().default(0),
  warned: z.array(z.string()).default([]),
  pending: pendingSchema.optional(),
  /** Result of ACT, persisted so VERIFY can resume after a crash. */
  act: z
    .object({ summary: z.string(), end: z.string(), turns: z.number(), usd: z.number() })
    .optional(),
  recordedCycle: z.number().default(0),
  checkpoints: z
    .array(
      z.object({
        milestoneId: z.string(),
        sha: z.string(),
        tag: z.string(),
        at: z.number(),
        usd: z.number(),
        tests: z.number().optional(),
      }),
    )
    .default([]),
  disabledWorkers: z.array(z.string()).default([]),
  noChecks: z.boolean().default(false),
});
export type RunState = z.infer<typeof stateSchema>;

export const controlSchema = z.object({
  request: z.enum(['pause', 'resume', 'stop', 'stop-now']),
  at: z.number(),
});
export type ControlRequest = z.infer<typeof controlSchema>;

export const heartbeatSchema = z.object({
  ts: z.number(),
  pid: z.number(),
  phase: z.string(),
  status: z.string(),
  cycle: z.number(),
  task: z.string().optional(),
  spentUsd: z.number(),
  lastGreen: z.string(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Every file of one run, under `$OMNEXX_HOME/runs/<runId>/` (outside the repo, plan §3.3). */
export class RunStore {
  readonly dir: string;

  constructor(
    paths: OmnexxPaths,
    readonly runId: string,
  ) {
    this.dir = runDir(paths, runId);
  }

  file(name: string): string {
    return join(this.dir, name);
  }
  get eventsPath(): string {
    return this.file('events.jsonl');
  }
  get logsDir(): string {
    return this.file('logs');
  }

  async init(): Promise<void> {
    for (const d of ['', 'logs', 'rejected', 'salvage'])
      await mkdir(join(this.dir, d), { recursive: true, mode: 0o700 });
  }

  async readState(): Promise<RunState> {
    let raw: unknown;
    try {
      raw = await readJson(this.file('state.json'));
    } catch (err) {
      throw new StateError(
        `cannot read state for ${this.runId}: ${(err as Error).message}`,
        'check `omnexx runs`',
      );
    }
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success)
      throw new StateError(
        `state.json for ${this.runId} is invalid: ${parsed.error.issues[0]?.message ?? ''}`,
      );
    return parsed.data;
  }

  async writeState(state: RunState): Promise<void> {
    await writeJsonAtomic(this.file('state.json'), stateSchema.parse(state));
  }

  async readPlan(): Promise<Plan | undefined> {
    const text = await readTextOr(this.file('plan.json'), '');
    if (!text) return undefined;
    return planSchema.parse(JSON.parse(text));
  }

  async writePlan(plan: Plan): Promise<void> {
    await writeJsonAtomic(this.file('plan.json'), planSchema.parse(plan));
  }

  async readGoal(): Promise<{ text: string; hash: string }> {
    const text = await readTextOr(this.file('goal.md'), '');
    return { text, hash: sha256(text) };
  }

  async writeGoal(text: string): Promise<void> {
    await writeFileAtomic(this.file('goal.md'), text.endsWith('\n') ? text : `${text}\n`);
  }

  async readNotes(): Promise<Note[]> {
    const text = await readTextOr(this.file('notes.json'), '[]');
    return notesSchema.parse(JSON.parse(text));
  }

  async writeNotes(notes: Note[]): Promise<void> {
    await writeJsonAtomic(this.file('notes.json'), notes);
    await writeFileAtomic(this.file('notes.md'), `# Lessons\n\n${renderNotes(notes)}\n`);
  }

  /** Append one journal entry per cycle; a replay after a crash doesn't add a duplicate. */
  async appendProgress(cycle: number, body: string): Promise<boolean> {
    const marker = `## Cycle ${cycle}\n`;
    const existing = await readTextOr(this.file('progress.md'), '');
    if (existing.includes(marker)) return false;
    await appendFile(this.file('progress.md'), `${marker}${body.trim()}\n\n`, { mode: 0o600 });
    return true;
  }

  async progressTail(n: number): Promise<string> {
    if (n === 0) return '';
    const text = await readTextOr(this.file('progress.md'), '');
    const entries = text.split(/^(?=## Cycle \d+\n)/m).filter((e) => e.startsWith('## Cycle'));
    return entries.slice(-n).join('').trim();
  }

  async readControl(): Promise<ControlRequest | undefined> {
    const text = await readTextOr(this.file('control.json'), '');
    if (!text) return undefined;
    const parsed = controlSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  }

  async writeControl(req: ControlRequest): Promise<void> {
    await writeJsonAtomic(this.file('control.json'), req);
  }

  async readHeartbeat(): Promise<Heartbeat | undefined> {
    const text = await readTextOr(this.file('heartbeat.json'), '');
    if (!text) return undefined;
    const parsed = heartbeatSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  }

  async writeHeartbeat(hb: Heartbeat): Promise<void> {
    await writeJsonAtomic(this.file('heartbeat.json'), hb);
  }
}

export async function listRunIds(paths: OmnexxPaths): Promise<string[]> {
  try {
    return (await readdir(runsDir(paths))).filter((d) => d.startsWith('r_')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
