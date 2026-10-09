import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../git/git.js';
import { writeFileAtomic } from './atomic.js';
import { readEvents } from './events.js';
import { childrenOf, type PlanNode } from './plan.js';
import { RunningContext } from './running-context.js';
import type { Run } from './run.js';

/** The newest gate screenshot taken after `since` (ms), as a path relative to the run dir. */
async function latestScreenshot(run: Run, since: number): Promise<string | undefined> {
  const dir = join(run.store.logsDir, 'screens');
  const files = await readdir(dir).catch(() => [] as string[]);
  let best: { f: string; t: number } | undefined;
  for (const f of files) {
    const t = (await stat(join(dir, f))).mtimeMs;
    if (t >= since && (!best || t > best.t)) best = { f, t };
  }
  return best ? join('logs', 'screens', best.f) : undefined;
}

/**
 * The proof of work for one finished milestone, written next to the run's other files (never in
 * the repo): what it was for, the tasks and how hard they were, the commits and the diff, test and
 * review evidence, spend, and a screenshot when a page gate ran. Returns the file path.
 */
export async function writeWalkthrough(run: Run, m: PlanNode): Promise<string> {
  const plan = run.requirePlan();
  const cps = run.state.checkpoints;
  const mine = cps.find((c) => c.milestoneId === m.id);
  const prev = mine ? cps[cps.indexOf(mine) - 1] : cps.at(-1);
  const from = prev?.sha ?? run.state.startRef;
  const to = mine?.sha ?? run.state.lastGreen;
  const range = `${from}..${to}`;
  const log = (
    await git(run.worktree, ['log', '--reverse', '--format=%h %s', range], { allowFailure: true })
  ).stdout.trim();
  const stat_ = (
    await git(run.worktree, ['diff', '--stat=100', range], { allowFailure: true })
  ).stdout.trim();
  const tasks = childrenOf(plan, m.id);
  const taskIds = new Set(tasks.map((t) => t.id));
  const events = await readEvents(run.store.eventsPath);
  const reviews = events.filter((e) => e.type === 'review.result' && taskIds.has(String(e.task)));
  const blocked = reviews.filter((e) => Number(e.blocking) > 0).length;
  const shot = await latestScreenshot(run, prev?.at ?? 0);
  const tests = mine?.tests;
  const prevTests = prev?.tests;
  const usd = (mine?.usd ?? run.state.spend.usd) - (prev?.usd ?? 0);
  const lines = [
    `# ${m.id}: ${m.title}`,
    '',
    m.why ? `${m.why}\n` : '',
    '## Tasks',
    '',
    ...tasks.map(
      (t) =>
        `- ${t.status === 'done' ? '[x]' : t.status === 'parked' ? '[p]' : '[ ]'} ${t.id} ${t.title}${t.attempts > 1 ? ` (${t.attempts} attempts)` : ''}${t.parkedReason ? ` — parked: ${t.parkedReason}` : ''}`,
    ),
    '',
    '## Evidence',
    '',
    `- Tests passing: ${tests ?? 'n/a'}${tests !== undefined && prevTests !== undefined ? ` (${tests - prevTests >= 0 ? '+' : ''}${tests - prevTests} this milestone)` : ''}`,
    `- Reviews: ${reviews.length}${blocked ? `, ${blocked} sent back for fixes before commit` : ''}`,
    `- Spend: $${usd.toFixed(2)}`,
    ...(mine ? [`- Checkpoint: \`${mine.tag}\` at ${mine.sha.slice(0, 10)}`] : []),
    ...(shot ? ['', '## How it looks', '', `![page after ${m.id}](../${shot})`] : []),
    '',
    ...(
      await RunningContext.archived(
        run.store,
        tasks.map((t) => t.id),
      )
    ).flatMap((c) => [
      `## Running context: ${c.key}`,
      '',
      c.text.replace(/^# Running context: [^\n]*\n/, '').trim(),
      '',
    ]),
    '## Commits',
    '',
    '```',
    log || '(none)',
    '```',
    '',
    '## Changed files',
    '',
    '```',
    stat_ || '(none)',
    '```',
    '',
    `To comment or redirect: \`omnexx steer ${run.state.runId} "<what to change>"\`.`,
    '',
  ];
  const file = run.store.file(join('walkthroughs', `${m.id}.md`));
  await writeFileAtomic(file, lines.join('\n'));
  run.events.emit('walkthrough.written', { milestone: m.id, path: file });
  return file;
}
