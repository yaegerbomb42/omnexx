import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCycleContext } from '../../../src/agent/context.js';
import { loadRoleCard, roleCard, sectionsSchema } from '../../../src/agent/sections.js';
import type { Plan, PlanNode } from '../../../src/core/plan.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

const task: PlanNode = {
  id: 'M1.T01',
  type: 'task',
  parentId: 'M1',
  title: 'Add login tests',
  why: 'login breaks often',
  acceptance: ['covers bad passwords'],
  checks: ['npm test'],
  dependsOn: [],
  size: 'M',
  kind: 'tests',
  steps: [],
  allow: [],
  status: 'doing',
  attempts: 0,
  consecutiveRejections: 0,
  approachesTried: [],
  failureSignatures: [],
  rung: 0,
  escalated: false,
  rungStartedAt: 0,
  splitInto: [],
  evidence: [],
};
const plan: Plan = {
  version: 1,
  goal: 'g',
  nodes: [{ ...task, id: 'M1', type: 'milestone', parentId: null, title: 'Auth' }, task],
};
const inputs = {
  systemPrompt: 'SYSTEM',
  codemap: 'CODEMAP '.repeat(500),
  goal: 'Ship auth',
  intent: 'INTENT text',
  notes: 'LESSON one',
  plan,
  task,
  progressTail: '## Cycle 1\nPROGRESS',
  evidence: [],
  role: '# Role: Test engineer for M1.T01',
  tools: [],
};
const text = (c: ReturnType<typeof buildCycleContext>) =>
  [...c.system.map((b) => b.text), JSON.stringify(c.first)].join('\n');

describe('context sections', () => {
  it('marks every block after the static worker prompt as volatile', () => {
    const c = buildCycleContext({
      ...inputs,
      sections: sectionsSchema.parse({ codemap: 'pinned' }),
    });
    expect(c.system.map((b) => Boolean(b.volatile))).toEqual([false, true, true, true]);
  });

  it('defaults: codemap optional (listed with its size), the rest pinned', () => {
    const c = buildCycleContext({ ...inputs, sections: sectionsSchema.parse({}) });
    const all = text(c);
    expect(all).not.toContain('CODEMAP CODEMAP');
    expect(all).toMatch(
      /Codebase map: files and their main symbols \(~\d+ tokens\) → context read scope=\\"repo\\"/,
    );
    for (const s of ['INTENT text', 'LESSON one', 'PROGRESS', 'Role: Test engineer'])
      expect(all).toContain(s);
    expect(c.labels).toEqual(['system', 'goal', 'notes']);
    expect(c.system.at(-1)?.cacheBreakpoint).toBe(true);
  });

  it('hidden sections are neither sent nor listed; all pinned keeps the old shape', () => {
    const c = buildCycleContext({
      ...inputs,
      sections: sectionsSchema.parse({ codemap: 'hidden', lessons: 'hidden', intent: 'optional' }),
    });
    const all = text(c);
    expect(all).not.toContain('CODEMAP');
    expect(all).not.toContain('LESSON one');
    expect(all).not.toContain('Codebase map:');
    expect(all).toContain('Intent: what the finished product should be');
    const old = buildCycleContext(inputs);
    expect(old.labels).toEqual(['system', 'codemap', 'goal', 'notes']);
    expect(text(old)).not.toContain('More context, on request');
  });

  it('renders the cached prefix as the same bytes every time', () => {
    expect(JSON.stringify(buildCycleContext(inputs))).toBe(
      JSON.stringify(buildCycleContext(inputs)),
    );
  });
});

describe('role card', () => {
  it('is written from the task: role by kind, done-when and checks', () => {
    const card = roleCard(task);
    expect(card).toMatch(/^# Role: Test engineer for M1.T01/);
    expect(card).toContain('Task: Add login tests');
    expect(card).toContain('- covers bad passwords');
    expect(card).toContain('- `npm test`');
  });

  it('is saved for editing, keeps edits, and adds the repo role note', async () => {
    const repo = await tempDir('role-');
    const ctx = await toolContext(repo);
    const first = await loadRoleCard(ctx.store, task, repo);
    const file = ctx.store.file(join('roles', 'M1.T01.md'));
    expect(await readFile(file, 'utf8')).toBe(first);
    await writeFile(file, '# Role: my own words\n');
    await mkdir(join(repo, '.omnexx'), { recursive: true });
    await writeFile(join(repo, '.omnexx', 'role.md'), 'Prefer small commits.\n');
    const edited = await loadRoleCard(ctx.store, task, repo);
    expect(edited).toContain('# Role: my own words');
    expect(edited).toContain('## For this repository\n\nPrefer small commits.');
  });
});
