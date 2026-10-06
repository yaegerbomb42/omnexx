import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readEvents, type OmnexxEvent } from '../../src/core/events.js';
import { getNode } from '../../src/core/plan.js';
import { REPORT_SECTIONS } from '../../src/core/report.js';
import { supervise } from '../../src/core/supervisor.js';
import { git } from '../../src/git/git.js';
import { isClean } from '../../src/git/repo.js';
import type { NotifyPayload } from '../../src/notify/ntfy.js';
import { fileTask, fileWorker, planner, scenario } from '../support/scenarios.js';
import { call, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { makeRepo, startTestRun, type TestRun } from '../support/harness.js';
import { json, mockServer } from '../support/mock-http.js';

const GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};
const fastOpts = (pushes: NotifyPayload[] = []) => ({
  bootId: 'boot-a',
  heartbeatMs: 50,
  controlPollMs: 20,
  pausePollMs: 10,
  notifier: {
    notify: (p: NotifyPayload) => {
      pushes.push(p);
      return Promise.resolve();
    },
  },
});
const types = (events: OmnexxEvent[], t: string) => events.filter((e) => e.type === t);

async function superviseTest(t: TestRun, pushes: NotifyPayload[] = []) {
  return supervise(t.run.deps, t.run.state.runId, fastOpts(pushes));
}

describe('M2: hierarchical plan, milestones, checkpoints and the report', () => {
  it('runs a 3-milestone plan milestone by milestone with rolling-wave expansion and a failing-milestone re-plan', async () => {
    const plan = planner(
      [
        {
          id: 'M1',
          title: 'First',
          checks: ['test -f out/M1.T01.txt'],
          tasks: [fileTask('M1.T01'), fileTask('M1.T02', { dependsOn: ['M1.T01'] })],
        },
        { id: 'M2', title: 'Second', checks: ['test -f out/M2.extra.txt'], dependsOn: ['M1'] },
        { id: 'M3', title: 'Third', checks: ['test -f out/M3.T01.txt'], dependsOn: ['M2'] },
      ],
      { M2: [fileTask('M2.T01')], M3: [fileTask('M3.T01')] },
      {
        M2: [
          { id: 'M2.T02', title: 'Create out/M2.extra.txt', checks: ['test -f out/M2.extra.txt'] },
        ],
      },
    );
    const worker: Script = (m) =>
      m.taskId === 'M2.T02'
        ? m.turn === 0
          ? call('write_file', { path: 'out/M2.extra.txt', content: 'x\n' })
          : say('ok')
        : fileWorker(m);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, worker)),
      config: { gates: [GATE] },
    });
    const pushes: NotifyPayload[] = [];
    const out = await superviseTest(t, pushes);

    expect(out).toMatchObject({ status: 'finished', exitCode: 0 });
    const events = await readEvents(t.run.store.eventsPath);
    const done = types(events, 'milestone.done').map((e) => e.milestone);
    expect(done).toEqual(['M1', 'M2', 'M3']);
    // M2's tasks were done before its own check passed: it was not marked done then.
    const failed = types(events, 'milestone.checks_failed');
    expect(failed.map((e) => e.milestone)).toEqual(['M2']);
    expect(events.indexOf(failed[0] as OmnexxEvent)).toBeLessThan(
      events.findIndex((e) => e.type === 'milestone.done' && e.milestone === 'M2'),
    );
    expect(types(events, 'planner.start').map((e) => e.mode)).toEqual([
      'initial',
      'expand',
      'replan',
      'expand',
    ]);

    const tags = (
      await git(t.run.worktree, ['tag', '--list', `omnexx/${t.run.state.runId}/*`])
    ).stdout
      .split('\n')
      .filter(Boolean);
    expect(tags).toEqual(['M1', 'M2', 'M3'].map((m) => `omnexx/${t.run.state.runId}/${m}`));
    expect(t.run.state.checkpoints).toHaveLength(0); // the in-memory Run in the test is stale; read from disk:
    const state = await t.run.store.readState();
    expect(state.checkpoints.map((c) => c.milestoneId)).toEqual(['M1', 'M2', 'M3']);
    expect(state.acceptedCommits).toBe(5);

    const report = await readFile(t.run.store.file('REPORT.md'), 'utf8');
    for (const s of REPORT_SECTIONS) expect(report).toContain(`## ${s}`);
    expect(report).toContain('**finished**');
    expect(report).toContain('Tasks: 5 done, 0 parked, 0 open of 5. Milestones: 3/3.');
    expect(report).toContain(`5 commits on top of`);
    expect(report).toMatch(/\| out\/ \| 5 \| 5 \| 0 \|/);
    expect(pushes.map((p) => p.kind)).toEqual(['started', 'finished']);
    expect(await isClean(t.repo)).toBe(true);
  });

  it('a re-plan that deletes a node is refused and the planner has to keep it', async () => {
    let attempt = 0;
    const plan = (m: Parameters<Script>[0]) => {
      if (m.turn > 0) return say('ok');
      const text = m.request.messages[0]?.content[0];
      if (text?.type === 'text' && text.text.startsWith('There is no plan yet')) {
        return call('write_plan', {
          milestones: [
            { id: 'M1', title: 'One', tasks: [fileTask('M1.T01')] },
            { id: 'M2', title: 'Two', dependsOn: ['M1'] },
          ],
        });
      }
      attempt++;
      // First expansion drops M1 entirely (refused); the retry keeps it.
      return attempt === 1
        ? call('write_plan', {
            milestones: [{ id: 'M2', title: 'Two', tasks: [fileTask('M2.T01')] }],
          })
        : call('write_plan', {
            milestones: [
              { id: 'M1', title: 'One', tasks: [fileTask('M1.T01')] },
              { id: 'M2', title: 'Two', dependsOn: ['M1'], tasks: [fileTask('M2.T01')] },
            ],
          });
    };
    const provider = new ScriptedProvider(
      scenario(
        (m) =>
          m.turn === 1 && attempt === 1
            ? (attempt++,
              call('write_plan', {
                milestones: [
                  { id: 'M1', title: 'One', tasks: [fileTask('M1.T01')] },
                  { id: 'M2', title: 'Two', dependsOn: ['M1'], tasks: [fileTask('M2.T01')] },
                ],
              }))
            : plan(m),
        fileWorker,
      ),
    );
    const t = await startTestRun({ repo: await makeRepo(), provider, config: { gates: [GATE] } });
    expect((await superviseTest(t)).status).toBe('finished');
    expect(JSON.stringify(provider.requests.map((r) => r.messages))).toMatch(
      /plan rejected: plan update would delete M1, M1.T01 \(nodes are never deleted/,
    );
  });
});

describe('M2: stuck handling, budget and judge', () => {
  it('impossible-task: 3 rejections escalate to the strong model, 3 more ask the planner to split it (it cannot), then it parks; nothing runnable → needs-human (exit 2) and a push', async () => {
    const plan = planner([
      {
        id: 'M1',
        title: 'Math',
        tasks: [{ id: 'M1.T01', title: 'Make 2+2 both 4 and 5', checks: ['node --test'] }],
      },
    ]);
    const worker: Script = (m) =>
      m.turn === 0
        ? call('str_replace', {
            path: 'src/math.js',
            old_str: 'return a + b;',
            new_str: `return a + b + ${m.attempt};`,
          })
        : say(`Tried +${m.attempt}`);
    const t = await startTestRun({
      fixture: 'impossible-task',
      provider: new ScriptedProvider(scenario(plan, worker)),
      config: { gates: [GATE] },
    });
    const pushes: NotifyPayload[] = [];
    const out = await superviseTest(t, pushes);
    expect(out).toMatchObject({ status: 'needs-human', exitCode: 2 });
    const events = await readEvents(t.run.store.eventsPath);
    expect(types(events, 'rollback')).toHaveLength(6);
    expect(types(events, 'ladder.rung').map((e) => e.rung)).toEqual([
      'escalate_model',
      'replan_task',
      'park',
      'stop_and_ask',
    ]);
    // Cycles 1-3 use the worker model; after escalation, cycles 4-6 use the planner model.
    const models = (t.run.deps.provider as ScriptedProvider).requests
      .filter((q) => JSON.stringify(q.messages[0]).includes('Work on M1.T01'))
      .map((q) => q.model);
    expect(new Set(models.slice(0, 6))).toEqual(new Set(['claude-sonnet-5-5']));
    expect(new Set(models.slice(6))).toEqual(new Set(['claude-opus-5-5']));
    expect(
      types(events, 'stuck.signal')
        .map((e) => e.signal)
        .sort(),
    ).toEqual([
      'consecutive_rejections',
      'consecutive_rejections',
      'repeated_signature',
      'repeated_signature',
    ]);
    const plan2 = await t.run.store.readPlan();
    expect(plan2 && getNode(plan2, 'M1.T01')).toMatchObject({
      status: 'parked',
      escalated: true,
      approachesTried: ['Tried +1', 'Tried +2', 'Tried +3', 'Tried +4', 'Tried +5', 'Tried +6'],
    });
    expect(pushes.at(-1)).toMatchObject({ kind: 'needs-human', parked: 1 });
    expect(await readFile(t.run.store.file('REPORT.md'), 'utf8')).toMatch(
      /## 7\. Needs your decision\n\n- M1\.T01 Make 2\+2 both 4 and 5: consecutive_rejections/,
    );
  });

  it('a task that stays stuck on the strong model is split by the planner; the run finishes when the pieces are done', async () => {
    const plan = planner(
      [
        {
          id: 'M1',
          title: 'Work',
          tasks: [
            { id: 'M1.T01', title: 'Hard task', checks: ['test -f out/hard.txt'] },
            fileTask('M1.T02', { dependsOn: ['M1.T01'] }),
          ],
        },
      ],
      {},
      {},
      { 'M1.T01': [fileTask('M1.T03'), fileTask('M1.T04', { dependsOn: ['M1.T03'] })] },
    );
    // The hard task never succeeds directly; the pieces it is split into do.
    const worker: Script = (m) =>
      m.taskId === 'M1.T01'
        ? m.turn === 0
          ? call('write_file', { path: 'out/wrong.txt', content: String(m.attempt) })
          : say(`attempt ${m.attempt}`)
        : fileWorker(m);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, worker)),
      config: { gates: [GATE] },
    });
    const out = await superviseTest(t);
    expect(out.status).toBe('finished');
    const events = await readEvents(t.run.store.eventsPath);
    expect(types(events, 'task.split')).toMatchObject([
      { task: 'M1.T01', into: ['M1.T03', 'M1.T04'] },
    ]);
    expect(types(events, 'ladder.rung').map((e) => e.rung)).toEqual([
      'escalate_model',
      'replan_task',
    ]);
    const final = await t.run.store.readPlan();
    expect(final && getNode(final, 'M1.T01')).toMatchObject({
      status: 'done',
      splitInto: ['M1.T03', 'M1.T04'],
    });
    // M1.T02 depended on the hard task; it now waits for the pieces instead.
    expect(final && getNode(final, 'M1.T02').dependsOn).toEqual(['M1.T03', 'M1.T04']);
    // The hard task's partial commits come first; after the split, the pieces then its dependent.
    expect(
      types(events, 'commit')
        .map((e) => e.task)
        .filter((x) => x !== 'M1.T01'),
    ).toEqual(['M1.T03', 'M1.T04', 'M1.T02']);
    expect(types(events, 'stuck.signal').map((e) => e.signal)).toEqual([
      'task_cycles',
      'task_cycles',
    ]);
  });

  it('oscillation (A→B→A) is detected within one cycle and the rejection names the signal', async () => {
    const plan = planner([
      {
        id: 'M1',
        title: 'Flip',
        tasks: [
          { id: 'M1.T01', title: 'Set value to B', checks: ['grep -q B value.txt'] },
          {
            id: 'M1.T02',
            title: 'Add notes file',
            checks: ['test -f notes.txt'],
            dependsOn: ['M1.T01'],
          },
        ],
      },
    ]);
    const worker: Script = (m) => {
      if (m.taskId === 'M1.T01')
        return m.turn === 0
          ? call('write_file', { path: 'value.txt', content: 'B\n' })
          : say('set B');
      return m.turn === 0
        ? call('write_file', { path: 'value.txt', content: 'A\n' })
        : say('reverted value');
    };
    const t = await startTestRun({
      repo: await makeRepo({ 'value.txt': 'A\n' }),
      provider: new ScriptedProvider(scenario(plan, worker)),
      config: { gates: [GATE] },
    });
    await superviseTest(t);
    const events = await readEvents(t.run.store.eventsPath);
    const osc = types(events, 'stuck.signal').filter((e) => e.signal === 'oscillation');
    expect(osc.length).toBeGreaterThanOrEqual(1);
    expect(osc[0]?.cycle).toBe(2);
    const v = types(events, 'verify.result').find((e) => e.cycle === 2);
    expect(JSON.stringify(v?.reasons)).toContain('stuck oscillation');
  });

  it('a tiny max_usd stops the run (exit 3) with lastGreen intact; raising the cap and resuming continues', async () => {
    const plan = planner([
      {
        id: 'M1',
        title: 'Files',
        tasks: [fileTask('M1.T01'), fileTask('M1.T02'), fileTask('M1.T03')],
      },
    ]);
    const provider = new ScriptedProvider(scenario(plan, fileWorker));
    const t = await startTestRun({
      repo: await makeRepo(),
      provider,
      config: {
        gates: [GATE],
        budget: { max_usd: 0.04, wrapup_reserve: 0 },
        providers: { anthropic: { max_tokens: 500 } },
      },
    });
    const first = await superviseTest(t);
    expect(first).toMatchObject({ status: 'budget-stop', exitCode: 3 });
    const s1 = await t.run.store.readState();
    expect(s1.spend.usd).toBeLessThanOrEqual(0.04);
    expect((await git(t.run.worktree, ['rev-parse', 'HEAD'])).stdout).toBe(s1.lastGreen);
    expect(await isClean(t.run.worktree)).toBe(true);

    const raised = {
      ...t.run.deps,
      config: { ...t.run.deps.config, budget: { ...t.run.deps.config.budget, max_usd: 50 } },
    };
    const second = await supervise(raised, t.run.state.runId, fastOpts());
    expect(second.status).toBe('finished');
    const s2 = await t.run.store.readState();
    expect(s2.acceptedCommits).toBe(3);
    expect(types(await readEvents(t.run.store.eventsPath), 'run.resume')).toHaveLength(1);
  });

  it('daily cap: the run pauses when the rolling 24 h spend nears the cap, then resumes and finishes', async () => {
    const plan = planner([
      {
        id: 'M1',
        title: 'Files',
        tasks: [fileTask('M1.T01'), fileTask('M1.T02'), fileTask('M1.T03'), fileTask('M1.T04')],
      },
    ]);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, fileWorker)),
      config: {
        gates: [GATE],
        // Just above one worst-case call (tools + prompt), so it must pause between cycles.
        budget: { max_usd_per_day: 0.04, max_hours: 2 },
        providers: { anthropic: { max_tokens: 500 } },
      },
    });
    const pushes: NotifyPayload[] = [];
    const out = await superviseTest(t, pushes);
    expect(out.status).toBe('finished');
    const events = await readEvents(t.run.store.eventsPath);
    const pauses = types(events, 'budget.daily_pause');
    expect(pauses.length).toBeGreaterThanOrEqual(1);
    expect(types(events, 'budget.daily_resume')).toHaveLength(pauses.length);
    expect(pushes.some((x) => x.kind === 'budget' && (x.hint ?? '').includes('daily cap'))).toBe(
      true,
    );
    // The pauses lasted a simulated day or more, yet max_hours = 2 didn't stop the run.
    expect(t.clock.now() - 1_700_000_000_000).toBeGreaterThan(20 * 3_600_000);
    const state = await t.run.store.readState();
    expect(state.acceptedCommits).toBe(4);
    // A cycle cut by the cap before any change is not an attempt.
    const final = await t.run.store.readPlan();
    for (const id of ['M1.T01', 'M1.T02', 'M1.T03', 'M1.T04'])
      expect(final && getNode(final, id).consecutiveRejections).toBe(0);
  });

  it('wrap-up reserve: no new task starts in the reserve window; report written, lastGreen clean', async () => {
    const plan = planner([
      {
        id: 'M1',
        title: 'Files',
        tasks: [fileTask('M1.T01'), fileTask('M1.T02'), fileTask('M1.T03')],
      },
    ]);
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, fileWorker)),
      config: { gates: [GATE], budget: { max_hours: 1, wrapup_reserve: 0.4 } },
    });
    // Each scripted turn advances the fake clock by 5 minutes: after ~11 turns we're in the reserve.
    const inner = t.run.deps.provider;
    t.run.deps.provider = {
      name: 'slow',
      complete: (r) => {
        t.clock.advance(10 * 60_000);
        return inner.complete(r);
      },
    };
    const out = await superviseTest(t);
    expect(out.status).toBe('budget-stop');
    expect(out.reason).toMatch(/wrap-up reserve/);
    const events = await readEvents(t.run.store.eventsPath);
    const starts = types(events, 'cycle.start');
    const wrap = events.findIndex((e) => e.type === 'phase' && e.phase === 'wrapup');
    expect(wrap).toBeGreaterThan(-1);
    expect(events.slice(wrap).some((e) => e.type === 'cycle.start')).toBe(false);
    expect(starts.length).toBeLessThan(3);
    expect(types(events, 'final.verify')).toHaveLength(1);
    expect(await readFile(t.run.store.file('REPORT.md'), 'utf8')).toContain('wrap-up reserve');
    expect(await isClean(t.run.worktree)).toBe(true);
  });

  it('editing goal.md mid-run is picked up next cycle and logged by hash', async () => {
    const plan = planner([
      { id: 'M1', title: 'Files', tasks: [fileTask('M1.T01'), fileTask('M1.T02')] },
    ]);
    let edited = false;
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(scenario(plan, fileWorker)),
      config: { gates: [GATE] },
    });
    t.run.deps.hooks = {
      onPhase: async (phase, cycle) => {
        if (phase === 'record' && cycle === 1 && !edited) {
          edited = true;
          await writeFile(t.run.store.file('goal.md'), 'A different goal\n');
        }
      },
    };
    const provider = t.run.deps.provider as ScriptedProvider;
    await superviseTest(t);
    const events = await readEvents(t.run.store.eventsPath);
    const changed = types(events, 'goal.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.to).toMatch(/^[0-9a-f]{64}$/);
    const cycle2 = provider.requests.find((r) =>
      JSON.stringify(r.messages[0]).includes('Work on M1.T02'),
    );
    expect(JSON.stringify(cycle2?.system)).toContain('A different goal');
  });

  it('judge invariant: advise mode with arbitrary answers produces identical commits and rollbacks to judge off', async () => {
    const answers = [
      'continue',
      'ask_human',
      'park_and_move_on',
      'split_task',
      'switch_to_strong_model',
    ];
    let n = 0;
    const srv = await mockServer((req, res) => {
      if (req.url === '/api/version') {
        json(res, 200, { version: '0.35.1' });
        return;
      }
      const q = (
        JSON.parse(req.body) as { questions: { name: string; type: string; options?: string[] }[] }
      ).questions;
      const out: Record<string, unknown> = {};
      for (const x of q) {
        const pick = x.options
          ? x.options.includes(answers[n % answers.length] ?? '')
            ? answers[n % answers.length]
            : x.options[0]
          : undefined;
        n++;
        out[x.name] =
          x.type === 'choice'
            ? { choice: pick, probabilities: { [pick ?? '']: 0.99 }, confidence: 0.99 }
            : { probability: n % 2 ? 0.05 : 0.95 };
      }
      json(res, 200, { answers: out });
    });
    const runOnce = async (judge: object) => {
      const plan = planner([
        {
          id: 'M1',
          title: 'Mixed',
          tasks: [
            fileTask('M1.T01'),
            { id: 'M1.T02', title: 'Impossible', checks: ['false'] },
            fileTask('M1.T03'),
          ],
        },
      ]);
      const t = await startTestRun({
        repo: await makeRepo(),
        provider: new ScriptedProvider(scenario(plan, fileWorker)),
        config: { gates: [GATE], judge },
        fetch: globalThis.fetch,
      });
      await superviseTest(t);
      const log = (
        await git(t.run.worktree, ['log', '--format=%s %T', `${t.run.state.startRef}..HEAD`])
      ).stdout;
      const events = await readEvents(t.run.store.eventsPath);
      return {
        log,
        rollbacks: types(events, 'rollback').map((e) => e.task),
        status: (await t.run.store.readState()).status,
        judged: types(events, 'judge.decision').length,
      };
    };
    const off = await runOnce({ kind: 'none' });
    const advise = await runOnce({ kind: 'nimble', mode: 'advise', nimble: { url: srv.url } });
    expect(advise.judged).toBeGreaterThan(0);
    expect({ ...advise, judged: 0 }).toEqual({ ...off, judged: 0 });
  });
});
