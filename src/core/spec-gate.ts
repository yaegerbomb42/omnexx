import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { readIntent } from '../agent/intent.js';
import { git } from '../git/git.js';
import {
  DISPUTE_FILE,
  judgeDispute,
  publicInterface,
  SPEC_DIR,
  specTestsWanted,
  suiteBroken,
  suiteSchema,
  writeSpecSuite,
  type SpecSuite,
} from '../verify/spec-tests.js';
import { readJson, readTextOr, writeJsonAtomic } from './atomic.js';
import { applyPlanUpdate, getNode } from './plan.js';
import type { Run } from './run.js';

/**
 * The spec-test gate in the run loop: write the suite once, run it before the run may finish,
 * send failures back as a fix task (the failing output is its evidence), and let a judge settle
 * the worker's disputes. Everything fails open: a writer or judge outage, a suite that can't run,
 * or fix rounds spent never stop a run from finishing; the events say what happened.
 */

const SUITE_FILE = 'spec-tests.json';
const MAX_SOURCE_FILES = 40;
const EVIDENCE_OUTPUT_CHARS = 4_000;
const EVIDENCE_TESTS_CHARS = 8_000;

type SpecState = NonNullable<Run['state']['specTests']>;

async function setSpec(r: Run, next: SpecState): Promise<void> {
  r.state.specTests = next;
  await r.save();
}

async function readSuite(r: Run): Promise<SpecSuite | undefined> {
  const parsed = suiteSchema.safeParse(await readJson(r.store.file(SUITE_FILE)).catch(() => null));
  return parsed.success ? parsed.data : undefined;
}

async function changedSources(r: Run): Promise<{ path: string; text: string }[]> {
  const names = (
    await git(r.worktree, ['diff', '--name-only', `${r.state.startRef}..HEAD`], {
      allowFailure: true,
    })
  ).stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_SOURCE_FILES);
  const files = await Promise.all(
    names.map(async (path) => ({ path, text: await readTextOr(join(r.worktree, path), '') })),
  );
  return files.filter((f) => f.text);
}

interface PackageFacts {
  type?: unknown;
  scripts?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function describePackage(text: string): string {
  if (!text) return 'no package.json';
  try {
    const p = JSON.parse(text) as PackageFacts;
    const deps = Object.keys({ ...p.dependencies, ...p.devDependencies });
    const type = typeof p.type === 'string' ? p.type : 'commonjs';
    return `package.json: type=${type}, scripts=${JSON.stringify(p.scripts ?? {})}, deps=${deps.join(', ')}`;
  } catch {
    return 'package.json: unreadable';
  }
}

async function projectFacts(r: Run): Promise<string> {
  const gates = r.config.gates.map((g) => `- gate ${g.name}: \`${g.run}\``).join('\n');
  const pkg = describePackage(await readTextOr(join(r.worktree, 'package.json'), ''));
  return [gates || '- no test gates configured', pkg].join('\n');
}

/** Keep the spec files and the dispute note out of every commit, even while they exist. */
async function excludeFromGit(r: Run): Promise<void> {
  const rel = (await git(r.worktree, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim();
  const path = isAbsolute(rel) ? rel : join(r.worktree, rel);
  const have = await readTextOr(path, '');
  const want = [`/${SPEC_DIR}/`, `/${DISPUTE_FILE}`].filter((l) => !have.split('\n').includes(l));
  if (!want.length) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${have && !have.endsWith('\n') ? '\n' : ''}${want.join('\n')}\n`);
}

/** Copy the suite into the worktree, run it, and remove it again: it is never committed. */
async function runSuite(r: Run, suite: SpecSuite): Promise<{ pass: boolean; output: string }> {
  const dir = join(r.worktree, SPEC_DIR);
  await excludeFromGit(r);
  try {
    await mkdir(dir, { recursive: true });
    await Promise.all(suite.files.map((f) => writeFile(join(r.worktree, f.path), f.content)));
    const res = await r.exec(suite.command, {
      cwd: r.worktree,
      env: r.childEnv,
      timeoutMs: r.maxCmdTimeoutMs,
      logPath: `${r.store.logsDir}/spec-tests.log`,
      redact: (s) => r.redactor.text(s),
      signal: r.abort.signal,
    });
    return { pass: res.exitCode === 0 && !res.timedOut, output: res.output };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fixEvidence(suite: SpecSuite, output: string): string {
  const tests = suite.files
    .map((f) => `--- ${f.path}\n${f.content}`)
    .join('\n')
    .slice(0, EVIDENCE_TESTS_CHARS);
  return [
    'Independent acceptance tests, written from the goal alone, fail against the code. Fix the code so they pass.',
    `They run with \`${suite.command}\` from ${SPEC_DIR}/ (kept out of the repo). Their output:\n${output.slice(-EVIDENCE_OUTPUT_CHARS)}`,
    `The tests:\n${tests}`,
    `The tests can be wrong too. First check the failing test against the goal: a setup step the goal itself forbids (the stack trace runs through the test's own helper), or an outcome the goal never states, means the test is wrong. Then don't bend the code to it: write ${DISPUTE_FILE} at the repo root naming the test file and quoting the goal's words that it contradicts, and change nothing else. A judge decides; a rejected dispute leaves the test standing.`,
  ].join('\n\n');
}

/** A new milestone with one task: make the failing spec tests pass. Returns the task id. */
async function addFixTask(
  r: Run,
  suite: SpecSuite,
  output: string,
  round: number,
  ruling?: string,
): Promise<string> {
  const plan = r.requirePlan();
  const next = Math.max(0, ...plan.nodes.map((n) => Number(/^M(\d+)/.exec(n.id)?.[1] ?? 0))) + 1;
  const id = `M${next}`;
  const taskId = `${id}.T01`;
  r.plan = applyPlanUpdate(
    plan,
    {
      milestones: [
        {
          id,
          title: `Spec tests ${round}: fix what the acceptance tests caught`,
          tasks: [
            {
              id: taskId,
              title: 'Make the independent spec acceptance tests pass',
              why: 'Tests written from the goal alone, without seeing the code, fail: the code and its own tests may agree on a wrong behaviour.',
              acceptance: ['every spec acceptance test passes, or a judge upheld a dispute of it'],
              size: 'M',
            },
          ],
        },
      ],
    },
    plan.goal,
  );
  const task = getNode(r.plan, taskId);
  task.evidence = [fixEvidence(suite, output), ...(ruling ? [ruling] : [])];
  await r.savePlan();
  return taskId;
}

/**
 * Before the run may finish. True when it added a fix task (the caller selects again); false when
 * the run may go on to finish: tests passed, not wanted, unavailable, or out of fix rounds.
 */
export async function specGate(r: Run): Promise<boolean> {
  const st = r.state.specTests;
  if (st && st.status !== 'written') return false;
  const goal = (await r.store.readGoal()).text;
  if (!st) {
    if (!specTestsWanted(r.config, goal, r.state.writing)) {
      await setSpec(r, { status: 'skipped', rounds: 0, reason: 'not wanted for this goal' });
      return false;
    }
    const iface = publicInterface(await changedSources(r));
    const suite = await writeSpecSuite(r, {
      goal,
      intent: await readIntent(r.store),
      iface,
      project: await projectFacts(r),
    });
    if (!suite) {
      r.events.emit('spec_tests.unavailable', { error: 'the writer gave no usable suite' });
      await setSpec(r, { status: 'skipped', rounds: 0, reason: 'no usable suite' });
      return false;
    }
    await writeJsonAtomic(r.store.file(SUITE_FILE), suite);
    r.events.emit('spec_tests.written', { files: suite.files.map((f) => f.path) });
    await setSpec(r, { status: 'written', rounds: 0 });
  }
  return runGate(r);
}

async function runGate(r: Run): Promise<boolean> {
  const st = r.state.specTests ?? { status: 'written', rounds: 0 };
  const suite = await readSuite(r);
  if (!suite?.files.length) {
    await setSpec(r, { ...st, status: 'passed', reason: 'no spec tests left' });
    return false;
  }
  const { pass, output } = await runSuite(r, suite);
  r.events.emit('spec_tests.result', { round: st.rounds, pass, files: suite.files.length });
  if (pass) {
    await setSpec(r, { status: 'passed', rounds: st.rounds });
    return false;
  }
  if (suiteBroken(output)) {
    await setSpec(r, { status: 'skipped', rounds: st.rounds, reason: 'the suite could not run' });
    return false;
  }
  if (st.rounds >= r.config.review.spec_tests_max_rounds) {
    r.events.emit('spec_tests.failed_open', { rounds: st.rounds });
    await setSpec(r, { status: 'failed-open', rounds: st.rounds, reason: 'fix rounds spent' });
    return false;
  }
  const round = st.rounds + 1;
  const taskId = await addFixTask(r, suite, output, round, st.ruling);
  r.events.emit('spec_tests.fix', { round, task: taskId });
  await setSpec(r, { status: 'fixing', rounds: round, taskId });
  return true;
}

/** The worker's dispute, if it wrote one: judged, then removed. Returns a rejected ruling. */
async function settleDispute(r: Run, taskId: string): Promise<string | undefined> {
  const path = join(r.worktree, DISPUTE_FILE);
  const dispute = (await readTextOr(path, '')).trim();
  if (!dispute) return undefined;
  await rm(path, { force: true });
  const suite = await readSuite(r);
  if (!suite) return undefined;
  const task = getNode(r.requirePlan(), taskId);
  const goal = (await r.store.readGoal()).text;
  const failure = await readTextOr(`${r.store.logsDir}/spec-tests.log`, '');
  const verdict = await judgeDispute(r, goal, suite, failure, dispute);
  r.events.emit('spec_tests.dispute', {
    task: taskId,
    dropped: verdict?.drop ?? [],
    reason: verdict?.reason ?? 'the judge could not rule',
  });
  if (!verdict?.drop.length) {
    const ruling = `Your dispute was not upheld: ${verdict?.reason ?? 'the judge could not rule'}. Fix the code.`;
    task.evidence = [...task.evidence, ruling].slice(-3);
    await r.savePlan();
    return ruling;
  }
  const dropped = new Set(verdict.drop);
  await writeJsonAtomic(r.store.file(SUITE_FILE), {
    ...suite,
    files: suite.files.filter((f) => !dropped.has(f.path)),
  });
  if (task.status !== 'done') {
    task.status = 'parked';
    task.skipped = true;
    task.parkedReason = `spec test dispute upheld: ${verdict.reason}`.slice(0, 500);
    await r.savePlan();
  }
  return undefined;
}

/**
 * Each select: settle the open spec fix task. A dispute goes to the judge; a finished task sends
 * the suite back to the gate; a task the ladder parked is skipped so the run can still finish.
 */
export async function settleSpecWork(r: Run): Promise<void> {
  const st = r.state.specTests;
  if (st?.status !== 'fixing' || !st.taskId || !r.plan) return;
  const ruling = (await settleDispute(r, st.taskId)) ?? st.ruling;
  const task = getNode(r.requirePlan(), st.taskId);
  if (task.status === 'parked' && !task.skipped) {
    task.skipped = true;
    await r.savePlan();
    r.events.emit('spec_tests.failed_open', { rounds: st.rounds, task: task.id });
    await setSpec(r, { ...st, status: 'failed-open', reason: task.parkedReason ?? 'parked' });
    return;
  }
  if (task.status === 'done' || task.status === 'parked')
    await setSpec(r, { status: 'written', rounds: st.rounds, ...(ruling ? { ruling } : {}) });
  else if (ruling !== st.ruling) await setSpec(r, { ...st, ruling });
}
