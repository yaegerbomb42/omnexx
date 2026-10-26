import type { PlanUpdate } from '../../src/core/plan.js';
import { call, say, type Script, type ScriptMeta, type ScriptedTurn } from './scripted-provider.js';

/**
 * Reusable scripted scenarios. A worker answer is a pure function of (task, attempt, turn), so a
 * crash-and-resume replays identically; the planner answers initial / expand / re-plan requests.
 */

type MilestoneSpec = PlanUpdate['milestones'][number];

export const firstText = (m: ScriptMeta): string => {
  const b = m.request.messages[0]?.content[0];
  return b?.type === 'text' ? b.text : '';
};

/** Existing plan ids from the planner prompt (expand/re-plan), as milestones with task ids. */
export function existing(
  m: ScriptMeta,
): { id: string; title: string; tasks: { id: string; title: string }[] }[] {
  const raw = /Existing ids \(keep every one\):\n(\{.*\})/.exec(firstText(m))?.[1];
  if (!raw) return [];
  return (
    JSON.parse(raw) as {
      milestones: { id: string; title: string; tasks: { id: string; title: string }[] }[];
    }
  ).milestones;
}

/**
 * A planner that writes `initial` first, then on each expand/re-plan merges `expansions[milestoneId]`
 * (tasks) into the existing plan.
 */
export function planner(
  initial: MilestoneSpec[],
  expansions: Record<string, MilestoneSpec['tasks']> = {},
  replans: Record<string, MilestoneSpec['tasks']> = {},
  /** Tasks to add when the ladder asks to split a stuck task, keyed by that task's id. */
  splits: Record<string, MilestoneSpec['tasks']> = {},
): (m: ScriptMeta) => ScriptedTurn {
  return (m) => {
    if (m.turn > 0) return say('Plan written.');
    const text = firstText(m);
    if (text.startsWith('There is no plan yet')) return call('write_plan', { milestones: initial });
    const expand = /Expand milestone (M\d+)/.exec(text)?.[1];
    const replan = /milestone (M\d+)'s tasks are done but its checks fail/.exec(text)?.[1];
    const split = /Task (M\d+\.T\d+) is stuck/.exec(text)?.[1];
    const target = expand ?? replan ?? split?.split('.')[0] ?? '';
    const extra = (split ? splits[split] : expand ? expansions[target] : replans[target]) ?? [];
    const ms = existing(m).map((e) => {
      const spec = initial.find((i) => i.id === e.id);
      const tasks = e.tasks.map((t) => {
        const known = [
          ...(spec?.tasks ?? []),
          ...Object.values(expansions).flat(),
          ...Object.values(replans).flat(),
          ...Object.values(splits).flat(),
        ].find((x) => x?.id === t.id);
        return known ?? { id: t.id, title: t.title };
      });
      const add = e.id === target ? extra.filter((x) => !tasks.some((t) => t.id === x.id)) : [];
      return { ...(spec ?? { id: e.id, title: e.title }), tasks: [...tasks, ...add] };
    });
    return call('write_plan', { milestones: ms });
  };
}

/** Worker that completes task X by writing out/X.txt (the task's check is `test -f out/X.txt`). */
export const fileWorker: Script = (m) => {
  if (m.turn === 0)
    return call(
      'write_file',
      { path: `out/${m.taskId ?? 'unknown'}.txt`, content: `${m.taskId ?? ''}\n` },
      `Creating out/${m.taskId ?? ''}.txt`,
    );
  return say(`Wrote out/${m.taskId ?? ''}.txt.`);
};

/**
 * Worker for the orphan-process regression test (OMNEXX_TEST_SCENARIO=server). The first task
 * starts a server, then completes like fileWorker; every other task is fileWorker.
 *
 * server-a is a node http server backgrounded inside the persistent bash session (`&`), so
 * it is a grandchild of the shell and outlives the turn. It listens on an ephemeral port and
 * writes its pid/port to server-a.pid / server-a.port. It must be gone (pid dead, port free)
 * once the run ends.
 *
 * (A DevServer child via browser start_server is covered by unit tests instead: this VM has
 * no browser backend, so the browser tool does not load in scripted runs.)
 */
const serverScript = (name: string): string =>
  `const http = require('node:http');\n` +
  `const fs = require('node:fs');\n` +
  `const port = Number(process.env.PORT || 0);\n` +
  `const s = http.createServer((q, r) => { r.end('ok'); });\n` +
  `s.listen(port, '127.0.0.1', () => {\n` +
  `  fs.writeFileSync('${name}.port', String(s.address().port));\n` +
  `  fs.writeFileSync('${name}.pid', String(process.pid));\n` +
  `});\n` +
  `setInterval(() => {}, 60_000);\n`;

export const serverWorker: Script = (m) => {
  if (m.taskId !== 'M1.T01') return fileWorker(m);
  if (m.turn === 0)
    // .cjs: the test repos seed {"type":"module"}, so a .js file could not use require.
    return call('write_file', { path: 'server-a.cjs', content: serverScript('server-a') });
  if (m.turn === 1) return call('bash', { command: 'node server-a.cjs > server-a.log 2>&1 &' });
  if (m.turn === 2)
    return call('write_file', {
      path: 'out/M1.T01.txt',
      content: 'M1.T01\n',
    });
  return say('Server started; wrote out/M1.T01.txt.');
};

export const fileTask = (id: string, extra: object = {}) => ({
  id,
  title: `Create out/${id}.txt`,
  checks: [`test -f out/${id}.txt`],
  size: 'S' as const,
  ...extra,
});

/** Combine a planner and a worker script. */
export const scenario =
  (plan: (m: ScriptMeta) => ScriptedTurn, worker: Script): Script =>
  (m) =>
    m.planner
      ? plan(m)
      : m.request.system[0]?.text.includes('summarize source files') ||
          m.request.system[0]?.text.includes('consolidate')
        ? say('skip')
        : worker(m);

/** N tasks across milestones of `perMilestone`, all pre-expanded. */
export function manyTasks(n: number, perMilestone = 10): MilestoneSpec[] {
  const ms: MilestoneSpec[] = [];
  for (let i = 0; i < n; i++) {
    const m = Math.floor(i / perMilestone) + 1;
    let spec = ms.find((x) => x.id === `M${m}`);
    if (!spec) {
      spec = { id: `M${m}`, title: `Milestone ${m}`, tasks: [] };
      ms.push(spec);
    }
    spec.tasks = [
      ...(spec.tasks ?? []),
      fileTask(`M${m}.T${String((i % perMilestone) + 1).padStart(2, '0')}`),
    ];
  }
  return ms;
}

/** A write_plan call that keeps every existing milestone and adds `milestone`. */
export const addMilestone = (
  m: ScriptMeta,
  milestone: { id: string; title: string; tasks: object[] },
): ScriptedTurn =>
  call('write_plan', {
    milestones: [
      ...existing(m).map((e) => ({
        id: e.id,
        title: e.title,
        tasks: e.tasks.map((t) => fileTask(t.id)),
      })),
      milestone,
    ],
  });
