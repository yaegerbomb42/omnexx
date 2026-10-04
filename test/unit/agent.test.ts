import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCodemap,
  renderCodemap,
  setPurposes,
  updateCodemap,
} from '../../src/agent/codemap.js';
import { buildCycleContext, turnRequest } from '../../src/agent/context.js';
import { WORKER_SYSTEM } from '../../src/agent/prompts.js';
import { renderNotes, type Note } from '../../src/core/notes.js';
import { applyPlanUpdate, getNode } from '../../src/core/plan.js';
import { estimateTokens } from '../../src/core/tokens.js';
import { git } from '../../src/git/git.js';
import { WORKER_TOOLS, toolSpec } from '../../src/tools/registry.js';
import { tempRepo } from '../support/tmp.js';

describe('codemap', () => {
  it('builds, updates only touched files (others byte-identical), keeps purposes, and drops deleted files', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'a.ts'), 'export function alpha() {}\n');
    await writeFile(join(repo, 'b.test.ts'), "test('x', () => {});\n");
    await writeFile(join(repo, 'README.md'), '# hi\n');
    await writeFile(join(repo, '.env'), 'SECRET=1\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-qm', 'c']);
    let map = setPurposes(await buildCodemap(repo), { 'a.ts': 'alpha helpers' });
    expect(map.entries.map((e) => [e.path, e.kind])).toEqual([
      ['README.md', 'doc'],
      ['a.ts', 'source'],
      ['b.test.ts', 'test'],
    ]);
    const untouched = JSON.stringify(map.entries.find((e) => e.path === 'README.md'));

    await writeFile(join(repo, 'c.ts'), 'export class Gamma {}\n');
    await writeFile(join(repo, 'a.ts'), 'export function alpha() {}\n// comment\n');
    const r = await updateCodemap(map, repo, ['c.ts', 'a.ts', 'b.test.ts-gone']);
    map = r.map;
    expect(r.touched.sort()).toEqual(['a.ts', 'c.ts']);
    expect(map.entries.find((e) => e.path === 'c.ts')?.symbols).toEqual(['class Gamma']);
    expect(map.entries.find((e) => e.path === 'a.ts')?.purpose).toBe('alpha helpers');
    expect(JSON.stringify(map.entries.find((e) => e.path === 'README.md'))).toBe(untouched);
    expect(renderCodemap(map, 3_000)).toContain('c.ts (2): class Gamma');
  });

  it('stays under its cap on a large synthetic repo, degrading deterministically', () => {
    const entries = Array.from({ length: 4_000 }, (_, i) => ({
      path: `pkg${i % 40}/sub${i % 7}/deep/file${i}.ts`,
      kind: 'source' as const,
      lines: 100,
      symbols: ['function a', 'function b', 'class C'],
    }));
    for (const cap of [3_000, 800, 200, 30]) {
      const text = renderCodemap({ version: 1, entries }, cap);
      expect(estimateTokens(text), String(cap)).toBeLessThanOrEqual(Math.max(cap, 40));
      expect(renderCodemap({ version: 1, entries }, cap)).toBe(text);
    }
  });
});

describe('fresh context per cycle (property)', () => {
  const note = (i: number): Note => ({
    id: `N${i}`,
    type: 'convention',
    text: `lesson ${i}`,
    date: '2026-10-03',
  });

  it('cycle 1 and cycle 500 stay under a fixed bound and never include earlier transcripts', () => {
    const tools = WORKER_TOOLS.map(toolSpec);
    const contextFor = (cycle: number) => {
      const milestones = Array.from({ length: 30 }, (_, m) => ({
        id: `M${m + 1}`,
        title: `Milestone ${m + 1}`,
        tasks: Array.from({ length: 20 }, (_, t) => ({
          id: `M${m + 1}.T${String(t + 1).padStart(2, '0')}`,
          title: `Task ${t + 1} of milestone ${m + 1}`,
        })),
      }));
      const plan = applyPlanUpdate(undefined, { milestones }, 'goal');
      // Mark the first `cycle` tasks done, as a long run would.
      plan.nodes
        .filter((n) => n.type === 'task')
        .slice(0, Math.min(cycle, 590))
        .forEach((n) => {
          n.status = 'done';
        });
      const current =
        plan.nodes.find((n) => n.type === 'task' && n.status === 'todo') ?? getNode(plan, 'M1.T01');
      // Five-entry progress tail, whatever the cycle number.
      const progressTail = Array.from(
        { length: 5 },
        (_, i) => `## Cycle ${cycle - 4 + i}\nTask did something ${'x'.repeat(200)}`,
      ).join('\n\n');
      return buildCycleContext({
        systemPrompt: WORKER_SYSTEM,
        codemap: '# Codebase map\n' + 'src/file.ts (10)\n'.repeat(400),
        goal: 'Port the whole codebase.',
        notes: renderNotes(Array.from({ length: 20 }, (_, i) => note(i + 1))),
        plan,
        task: current,
        progressTail,
        evidence: [],
        tools,
      });
    };
    const size = (c: ReturnType<typeof contextFor>) => JSON.stringify(c).length;
    const c1 = contextFor(1);
    const c500 = contextFor(500);
    const BOUND = 60_000;
    expect(size(c1)).toBeLessThan(BOUND);
    expect(size(c500)).toBeLessThan(BOUND);
    expect(Math.abs(size(c500) - size(c1))).toBeLessThan(5_000);
    // The cycle-500 plan view shows milestone titles and only its current milestone's tasks.
    const text = JSON.stringify(c500.first);
    expect(text).toContain('<- current');
    expect((text.match(/M\d+\.T\d+ Task/g) ?? []).length).toBeLessThanOrEqual(21);
  });

  it('the stable prefix is byte-identical across turns; breakpoints sit on the state message and the latest message', () => {
    const plan = applyPlanUpdate(
      undefined,
      { milestones: [{ id: 'M1', title: 'Mile', tasks: [{ id: 'M1.T01', title: 'Task one' }] }] },
      'g',
    );
    const ctx = buildCycleContext({
      systemPrompt: WORKER_SYSTEM,
      codemap: 'map',
      goal: 'g',
      notes: 'n',
      plan,
      task: getNode(plan, 'M1.T01'),
      progressTail: '',
      evidence: ['failed before'],
      tools: [],
    });
    const r1 = turnRequest(ctx, [ctx.first], 'm', 100);
    const r3 = turnRequest(
      ctx,
      [
        ctx.first,
        { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
      ],
      'm',
      100,
    );
    expect(JSON.stringify(r1.system)).toBe(JSON.stringify(r3.system));
    expect(r1.messageBreakpoints).toEqual([0]);
    expect(r3.messageBreakpoints).toEqual([0, 2]);
    expect(ctx.system.at(-1)?.cacheBreakpoint).toBe(true);
    expect(JSON.stringify(ctx.first)).toContain('Evidence from earlier attempts');
  });
});
