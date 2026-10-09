import { intentAssumptions, readIntent } from '../agent/intent.js';
import { git } from '../git/git.js';
import { formatDuration } from '../config/duration.js';
import { readEvents, type OmnexxEvent } from './events.js';
import { writeFileAtomic } from './atomic.js';
import { childrenOf, milestones, planCounts, type Plan, type PlanNode } from './plan.js';
import type { RunState } from './run-store.js';
import type { RunStore } from './run-store.js';

export const REPORT_SECTIONS = [
  '1. Outcome',
  '2. Milestones and tasks',
  '3. What changed',
  '4. Test and gate deltas',
  '5. Where it struggled',
  '6. Spend',
  '7. Needs your decision',
  '8. How to review and merge',
] as const;

const MARK: Record<PlanNode['status'], string> = {
  todo: '[ ]',
  doing: '[~]',
  done: '[x]',
  parked: '[p]',
};
const count = (events: readonly OmnexxEvent[], type: string): number =>
  events.filter((e) => e.type === type).length;
const flakyIds = (events: readonly OmnexxEvent[]): string => {
  const ids = new Set(
    events
      .filter((e) => e.type === 'verify.flaky')
      .flatMap((e) => (Array.isArray(e.ids) ? e.ids.map(String) : [])),
  );
  return ids.size ? `${ids.size} (${[...ids].slice(0, 10).join(', ')})` : 'none';
};
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Integrations the agent wanted but couldn't install unattended, with the command to do it. */
function suggestions(events: readonly OmnexxEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events.filter((x) => x.type === 'integration.suggested')) {
    const line =
      e.kind === 'skill'
        ? `- The agent suggests adding skills from ${String(e.source)}: \`omnexx skills add ${String(e.source)}\``
        : `- The agent suggests the MCP server ${String(e.server)}${e.trusted ? '' : ' (not a known publisher: check it first)'}: \`omnexx mcp add ${String(e.server).split('/').pop() ?? ''} --pick ${String(e.server)}\``;
    if (!seen.has(line)) out.push(line);
    seen.add(line);
  }
  return out;
}

function planTree(plan: Plan | undefined): string[] {
  if (!plan) return ['(no plan was written)'];
  const out: string[] = [];
  for (const m of milestones(plan)) {
    out.push(
      `- ${MARK[m.status]} **${m.id}** ${m.title}${m.parkedReason ? ` — parked: ${m.parkedReason}` : ''}`,
    );
    for (const t of childrenOf(plan, m.id)) {
      const extra =
        t.status === 'parked'
          ? ` — parked: ${t.parkedReason ?? 'no reason'}${t.approachesTried.length ? `; tried: ${t.approachesTried.join(' | ')}` : ''}`
          : t.status === 'done'
            ? ` (cycle ${t.doneAtCycle ?? '?'}, ${t.attempts} attempt${t.attempts === 1 ? '' : 's'})`
            : t.attempts
              ? ` (${t.attempts} attempts so far)`
              : '';
      out.push(`  - ${MARK[t.status]} ${t.id} ${t.title}${extra}`);
    }
  }
  return out;
}

async function changes(state: RunState): Promise<string[]> {
  const range = `${state.startRef}..${state.lastGreen}`;
  const commits =
    (
      await git(state.worktree, ['rev-list', '--count', range], { allowFailure: true })
    ).stdout.trim() || '0';
  const numstat = (await git(state.worktree, ['diff', '--numstat', range], { allowFailure: true }))
    .stdout;
  const byDir = new Map<string, { files: number; added: number; removed: number }>();
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, r, path = ''] = line.split('\t');
    const dir = path.includes('/') ? `${path.split('/')[0] ?? ''}/` : '(root)';
    const cur = byDir.get(dir) ?? { files: 0, added: 0, removed: 0 };
    byDir.set(dir, {
      files: cur.files + 1,
      added: cur.added + (Number(a) || 0),
      removed: cur.removed + (Number(r) || 0),
    });
  }
  const log = (
    await git(state.worktree, ['log', '--format=%h %s', '-15', range], { allowFailure: true })
  ).stdout;
  return [
    `Branch \`${state.branch}\`, ${commits} commit${commits === '1' ? '' : 's'} on top of \`${state.startRef.slice(0, 10)}\`.`,
    '',
    '| Directory | Files | + | − |',
    '|---|---|---|---|',
    ...[...byDir.entries()]
      .sort()
      .map(([d, s]) => `| ${d} | ${s.files} | ${s.added} | ${s.removed} |`),
    ...(byDir.size ? [] : ['| (none) | 0 | 0 | 0 |']),
    '',
    'Recent commits:',
    '',
    ...(log.trim()
      ? log
          .trim()
          .split('\n')
          .map((l) => `- ${l}`)
      : ['- (none)']),
  ];
}

function deltas(state: RunState): string[] {
  const before = state.initialBaseline ?? {};
  const after = state.baseline ?? {};
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  if (!names.length) return ['No gates were configured.'];
  const rows = names.map((n) => {
    const b = before[n];
    const a = after[n];
    const fixed = b && a ? b.failureIds.filter((id) => !a.failureIds.includes(id)).length : 0;
    const tests = (g: typeof b) => (g?.tests ? `${g.tests.passed}/${g.tests.total}` : '-');
    return `| ${n} | ${b?.failureIds.length ?? '-'} | ${a?.failureIds.length ?? '-'} | ${fixed} | ${tests(b)} | ${tests(a)} |`;
  });
  return [
    'Baseline is the starting commit; final is `lastGreen`.',
    '',
    '| Gate | Failures before | Failures after | Known failures fixed | Tests passing before | Tests passing after |',
    '|---|---|---|---|---|---|',
    ...rows,
  ];
}

/**
 * The morning-after report (plan §14.4). Deterministic from state, plan and events: no model
 * call, so it can always be written, even after a budget stop.
 */
export async function writeReport(
  store: RunStore,
  state: RunState,
  plan: Plan | undefined,
  now: number,
): Promise<string> {
  const events = await readEvents(store.eventsPath);
  const c = plan ? planCounts(plan) : undefined;
  const s = state.spend;
  const input = s.tokens.uncached + s.tokens.cacheWrite + s.tokens.cacheRead;
  const stuck = events.filter((e) => e.type === 'stuck.signal');
  const rungs = events.filter((e) => e.type === 'ladder.rung');
  const parked = plan?.nodes.filter((n) => n.status === 'parked') ?? [];
  const workers = events.filter((e) => e.type === 'worker.result');
  const assumptions = intentAssumptions(await readIntent(store));
  const lines = [
    `# Omnexx report: ${state.repoName} · ${state.runId}`,
    '',
    `## ${REPORT_SECTIONS[0]}`,
    '',
    `**${state.status}**${state.statusReason ? `: ${state.statusReason}` : ''}`,
    '',
    `Active for ${formatDuration(state.activeMs)} (${formatDuration(now - state.startedAt)} since start), ${state.cycle} cycles: ${state.acceptedCommits} accepted commits, ${state.rejectedCycles} rejected.`,
    c
      ? `Tasks: ${c.done} done, ${c.parked} parked, ${c.todo} open of ${c.tasks}. Milestones: ${c.milestonesDone}/${c.milestones}.`
      : '',
    '',
    `## ${REPORT_SECTIONS[1]}`,
    '',
    ...planTree(plan),
    ...(state.checkpoints.length
      ? [
          '',
          `Walkthroughs (what each milestone did, with evidence): ${state.checkpoints.map((c) => `walkthroughs/${c.milestoneId}.md`).join(', ')}`,
        ]
      : []),
    '',
    `## ${REPORT_SECTIONS[2]}`,
    '',
    ...(await changes(state)),
    '',
    `## ${REPORT_SECTIONS[3]}`,
    '',
    ...deltas(state),
    '',
    `## ${REPORT_SECTIONS[4]}`,
    '',
    `- Rollbacks: ${count(events, 'rollback')}`,
    `- Stuck signals: ${stuck.length}${stuck.length ? ` (${[...new Set(stuck.map((e) => String(e.signal)))].join(', ')})` : ''}`,
    `- Ladder rungs used: ${rungs.length ? rungs.map((e) => `${String(e.task)} → ${String(e.rung)}`).join(', ') : 'none'}`,
    `- Flaky tests (passed on re-run): ${flakyIds(events)}`,
    `- Anti-cheat rejections: ${events.filter((e) => e.type === 'verify.result' && JSON.stringify(e.reasons).includes('anti-cheat')).length}`,
    `- Provider retries: ${count(events, 'provider.retry')}, outages over 15 min: ${count(events, 'provider.outage')}`,
    `- Crash recoveries: ${count(events, 'run.resume')}`,
    `- Judge: ${count(events, 'judge.decision')} answers, ${count(events, 'judge.miss')} misses`,
    `- Worker attempts: ${workers.length ? workers.map((e) => `${String(e.worker)}: ${String(e.outcome)}`).join(', ') : 'none (worker adapters arrive in M3)'}`,
    '',
    `## ${REPORT_SECTIONS[5]}`,
    '',
    `- Total: ${usd(s.usd)} over ${s.llmCalls} model calls (${s.turns} agent turns)`,
    `- Per accepted commit: ${state.acceptedCommits ? usd(s.usd / state.acceptedCommits) : 'n/a'}`,
    `- Tokens: ${s.tokens.uncached} uncached, ${s.tokens.cacheWrite} cache write, ${s.tokens.cacheRead} cache read, ${s.tokens.output} output`,
    `- Cache-hit ratio: ${input ? `${((s.tokens.cacheRead / input) * 100).toFixed(1)}%` : 'n/a'}`,
    ...Object.entries(s.byModel)
      .sort()
      .map(([k, v]) => `- ${k}: ${usd(v)}`),
    '',
    `## ${REPORT_SECTIONS[6]}`,
    '',
    ...(parked.length
      ? parked.map((n) => `- ${n.id} ${n.title}: ${n.parkedReason ?? ''}`)
      : ['- Nothing parked.']),
    ...(state.status === 'needs-human'
      ? [`- The run stopped for you: ${state.statusReason ?? ''}`]
      : []),
    ...suggestions(events),
    ...(assumptions.length
      ? [
          '',
          'Assumptions it made where your goal was open (change one with `omnexx steer`, then `omnexx resume`):',
          '',
          ...assumptions.map((a) => `- ${a}`),
        ]
      : []),
    '',
    `## ${REPORT_SECTIONS[7]}`,
    '',
    '```bash',
    `cd ${state.repoRoot}`,
    `git log --oneline ${state.startRef.slice(0, 10)}..${state.branch}`,
    `git diff --stat ${state.startRef.slice(0, 10)}..${state.branch}`,
    `git merge --no-ff ${state.branch}    # when you're happy`,
    `omnexx resume ${state.runId}          # to continue (raise the budget first if it stopped on one)`,
    '```',
    '',
    parked.length
      ? `Suggested next goal: unblock ${parked.map((p) => p.id).join(', ')}.`
      : 'Suggested next goal: review the branch, then set the next goal.',
    '',
  ];
  const text = lines.join('\n');
  await writeFileAtomic(store.file('REPORT.md'), text);
  return text;
}
