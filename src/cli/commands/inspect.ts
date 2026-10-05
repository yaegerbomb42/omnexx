import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pc from 'picocolors';
import { formatDuration } from '../../config/duration.js';
import { readTextOr } from '../../core/atomic.js';
import { readEvents } from '../../core/events.js';
import { STALE_AFTER_MS } from '../../core/heartbeat.js';
import { compactPlanView, planCounts } from '../../core/plan.js';
import { resolvePaths } from '../../core/paths.js';
import { writeReport } from '../../core/report.js';
import { listRunIds, RunStore } from '../../core/run-store.js';
import { git } from '../../git/git.js';
import { UsageError } from '../../errors.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import { pickRun, supervisorAlive } from './control.js';
import { brand } from '../brand.js';
import { emptyTelemetry, fold, tokensPerCommit } from '../../telemetry/aggregate.js';
import { EventTail } from '../../telemetry/feed.js';
import { humanize, type Verbosity } from '../../telemetry/humanize.js';

export async function statusData(store: RunStore, now: number) {
  const state = await store.readState();
  const plan = await store.readPlan();
  const hb = await store.readHeartbeat();
  const counts = plan ? planCounts(plan) : undefined;
  const t = state.spend.tokens;
  const input = t.uncached + t.cacheWrite + t.cacheRead;
  const events = await readEvents(store.eventsPath);
  const judge = events.filter((e) => e.type === 'judge.next_move');
  const agreed = judge.filter((e) => e.pick === e.rule).length;
  return {
    runId: state.runId,
    repo: state.repoName,
    branch: state.branch,
    status: state.status,
    reason: state.statusReason,
    phase: state.phase,
    cycle: state.cycle,
    task: state.taskId,
    lastGreen: state.lastGreen,
    tasks: counts,
    supervisorAlive: await supervisorAlive(store),
    heartbeat: hb
      ? { ageMs: now - hb.ts, stale: now - hb.ts > STALE_AFTER_MS, phase: hb.phase }
      : undefined,
    spend: {
      usd: state.spend.usd,
      tokens: t,
      cacheHitRatio: input ? t.cacheRead / input : 0,
      usdPerAcceptedCommit: state.acceptedCommits
        ? state.spend.usd / state.acceptedCommits
        : undefined,
      turns: state.spend.turns,
      llmCalls: state.spend.llmCalls,
      byModel: state.spend.byModel,
    },
    commits: state.acceptedCommits,
    rejected: state.rejectedCycles,
    activeMs: state.activeMs,
    checkpoints: state.checkpoints.length,
    telemetry: (() => {
      const tel = events.reduce((acc, e) => fold(acc, e), emptyTelemetry());
      return {
        toolCalls: tel.toolCalls,
        toolErrors: tel.toolErrors,
        gateRuns: tel.gateRuns,
        gatePassRate: tel.gateRuns ? tel.gatePasses / tel.gateRuns : undefined,
        rollbacks: tel.rollbacks,
        compactions: tel.compactions,
        tokensPerCommit: tokensPerCommit(tel),
        model: tel.model,
        provider: tel.provider,
      };
    })(),
    judge: {
      nextMoveCalls: judge.length,
      agreement: judge.length ? agreed / judge.length : undefined,
      misses: events.filter((e) => e.type === 'judge.miss').length,
    },
  };
}

export async function statusCommand(
  io: CliIO,
  runId: string | undefined,
  json: boolean,
): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), runId);
  const d = await statusData(store, Date.now());
  if (json) {
    println(io.stdout, JSON.stringify(d, null, 2));
    return EXIT.ok;
  }
  const hb = d.heartbeat
    ? `${formatDuration(d.heartbeat.ageMs)} ago${d.heartbeat.stale ? pc.yellow(' (stale)') : ''}`
    : 'none';
  println(
    io.stdout,
    `${pc.bold(d.runId)} ${d.repo} · ${d.status}${d.reason ? ` (${d.reason})` : ''}`,
  );
  println(
    io.stdout,
    `  phase ${d.phase}, cycle ${d.cycle}${d.task ? `, task ${d.task}` : ''}; supervisor ${d.supervisorAlive ? 'running' : 'not running'}; heartbeat ${hb}`,
  );
  if (d.tasks)
    println(
      io.stdout,
      `  tasks ${d.tasks.done}/${d.tasks.tasks} done, ${d.tasks.parked} parked; milestones ${d.tasks.milestonesDone}/${d.tasks.milestones}; checkpoints ${d.checkpoints}`,
    );
  println(
    io.stdout,
    `  ${d.commits} commits, ${d.rejected} rejected cycles; lastGreen ${d.lastGreen.slice(0, 10)} on ${d.branch}`,
  );
  println(
    io.stdout,
    `  $${d.spend.usd.toFixed(2)} spent; cache hits ${(d.spend.cacheHitRatio * 100).toFixed(0)}%; active ${formatDuration(d.activeMs)}`,
  );
  return EXIT.ok;
}

export async function runsCommand(io: CliIO): Promise<number> {
  const paths = resolvePaths(io.env);
  const ids = await listRunIds(paths);
  if (!ids.length) println(io.stdout, 'no runs yet');
  for (const id of ids) {
    const s = await new RunStore(paths, id).readState().catch(() => undefined);
    println(
      io.stdout,
      s
        ? `${id}  ${s.status.padEnd(12)} ${s.repoName}  cycle ${s.cycle}  $${s.spend.usd.toFixed(2)}  ${s.acceptedCommits} commits`
        : `${id}  (unreadable state)`,
    );
  }
  return EXIT.ok;
}

export async function logsCommand(
  io: CliIO,
  runId: string | undefined,
  opts: {
    follow?: boolean;
    events?: boolean;
    progress?: boolean;
    cmd?: string;
    verbosity?: Verbosity;
  },
): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), runId);
  if (opts.progress) {
    io.stdout.write(await readTextOr(store.file('progress.md'), '(no progress yet)\n'));
    return EXIT.ok;
  }
  if (opts.cmd) {
    if (!/^[A-Za-z0-9_.-]+$/.test(opts.cmd)) throw new UsageError(`bad log id ${opts.cmd}`);
    io.stdout.write(
      await readFile(store.file(`logs/${opts.cmd}.log`), 'utf8').catch(
        () => `no log ${opts.cmd}\n`,
      ),
    );
    return EXIT.ok;
  }
  const tail = new EventTail(store.eventsPath);
  const b = brand(io);
  const verbosity = opts.verbosity ?? 'normal';
  const flush = async (): Promise<void> => {
    for (const e of await tail.read()) {
      const line = opts.events ? JSON.stringify(e) : humanize(e, { brand: b, verbosity });
      if (line) println(io.stdout, line);
    }
  };
  await flush();
  if (!opts.follow) return EXIT.ok;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1_000));
    await flush();
    const s = await store.readState().catch(() => undefined);
    if (s?.phase === 'done' && !(await supervisorAlive(store))) return EXIT.ok;
  }
}

export async function diffCommand(
  io: CliIO,
  runId: string | undefined,
  since: string | undefined,
): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), runId);
  const s = await store.readState();
  let from = s.startRef;
  if (since) {
    const cp = s.checkpoints.find((c) => c.milestoneId === since);
    if (!cp) throw new UsageError(`no checkpoint for ${since}`, '`omnexx checkpoints` lists them');
    from = cp.sha;
  }
  const stat = await git(s.worktree, ['diff', '--stat', `${from}..${s.lastGreen}`]);
  const diff = await git(s.worktree, ['diff', `${from}..${s.lastGreen}`]);
  println(io.stdout, stat.stdout);
  println(io.stdout, diff.stdout);
  return EXIT.ok;
}

export async function checkpointsCommand(io: CliIO, runId: string | undefined): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), runId);
  const s = await store.readState();
  if (!s.checkpoints.length) println(io.stdout, 'no milestone checkpoints yet');
  for (const c of s.checkpoints) {
    println(
      io.stdout,
      `${c.milestoneId.padEnd(5)} ${c.sha.slice(0, 10)}  ${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}  ${c.tests !== undefined ? `${c.tests} tests passing` : '-'}  $${c.usd.toFixed(2)}  ${c.tag}`,
    );
  }
  return EXIT.ok;
}

export async function reportCommand(io: CliIO, runId: string | undefined): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), runId);
  const text = await writeReport(
    store,
    await store.readState(),
    await store.readPlan(),
    Date.now(),
  );
  io.stdout.write(text);
  println(io.stderr, `written to ${store.file('REPORT.md')}`);
  return EXIT.ok;
}

export async function planCommand(
  io: CliIO,
  runId: string | undefined,
  edit: boolean,
): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), runId);
  if (edit) {
    const editor = io.env.EDITOR ?? io.env.VISUAL ?? 'vi';
    await new Promise<void>((resolve) => {
      spawn(editor, [store.file('goal.md')], { stdio: 'inherit' }).on('exit', () => {
        resolve();
      });
    });
    println(io.stdout, 'goal.md saved; the run picks it up at the next cycle.');
    return EXIT.ok;
  }
  const plan = await store.readPlan();
  println(
    io.stdout,
    plan ? compactPlanView(plan, (await store.readState()).taskId) : 'no plan yet',
  );
  return EXIT.ok;
}
