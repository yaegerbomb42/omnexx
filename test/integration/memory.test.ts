import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { consolidateNotes, initCodemap, refreshCodemap } from '../../src/core/milestones.js';
import type { Note } from '../../src/core/notes.js';
import { call, ScriptedProvider, say, type Script } from '../support/scripted-provider.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../../src/git/git.js';

const notes: Note[] = [
  { id: 'N1', type: 'env', text: 'tests need DATABASE_URL', date: 'd' },
  { id: 'N2', type: 'command', text: 'run tests with pnpm test', date: 'd' },
  { id: 'N3', type: 'pitfall', text: 'the cache dir is shared', date: 'd' },
  { id: 'N4', type: 'pitfall', text: 'the cache directory is shared between tests', date: 'd' },
  { id: 'N5', type: 'convention', text: 'use named exports', date: 'd' },
  { id: 'N6', type: 'convention', text: 'prefer named exports everywhere', date: 'd' },
];

describe('notes consolidation at milestone boundaries', () => {
  const run = async (answer: unknown) => {
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider(() => call('answer', answer)),
    });
    await t.run.store.writeNotes(notes);
    return { t, applied: await consolidateNotes(t.run) };
  };

  it('applies a shorter result that keeps every env/command fact', async () => {
    const { t, applied } = await run({
      notes: [
        notes[0],
        notes[1],
        { id: 'N3', type: 'pitfall', text: 'cache dir is shared' },
        { id: 'N5', type: 'convention', text: 'use named exports' },
      ].map((n) => ({ id: n?.id, type: n?.type, text: n?.text })),
    });
    expect(applied).toBe(true);
    expect((await t.run.store.readNotes()).map((n) => n.id)).toEqual(['N1', 'N2', 'N3', 'N5']);
  });

  it('refuses a result that drops an env fact, or is not shorter', async () => {
    const dropped = await run({
      notes: [{ id: 'N2', type: 'command', text: 'run tests with pnpm test' }],
    });
    expect(dropped.applied).toBe(false);
    expect(await dropped.t.run.store.readNotes()).toHaveLength(6);
    const longer = await run({
      notes: [
        ...notes.map(({ id, type, text }) => ({
          id,
          type,
          text: `${text} (expanded with more words)`,
        })),
      ],
    });
    expect(longer.applied).toBe(false);
    const malformed = await run({ nope: true });
    expect(malformed.applied).toBe(false);
  });
});

describe('codemap with cheap-model purposes', () => {
  it('describes source files at cycle 0 and only new or changed ones after a commit', async () => {
    const asked: string[][] = [];
    const script: Script = (m) => {
      const text = JSON.stringify(m.request.messages);
      const paths = [...text.matchAll(/## ([\w/.-]+)\\n/g)].map((x) => x[1] ?? '');
      asked.push(paths);
      return paths.length
        ? call('answer', { purposes: paths.map((p) => ({ path: p, purpose: `purpose of ${p}` })) })
        : say('none');
    };
    const repo = await makeRepo({
      'src/a.js': 'export function a() {}\n',
      'src/b.js': 'export function b() {}\n',
    });
    const t = await startTestRun({ repo, provider: new ScriptedProvider(script) });
    await initCodemap(t.run);
    expect(asked).toEqual([['src/a.js', 'src/b.js']]);
    await writeFile(join(t.run.worktree, 'src/c.js'), 'export function c() {}\n');
    await git(t.run.worktree, ['add', '-A']);
    await refreshCodemap(t.run, ['src/c.js']);
    expect(asked.at(-1)).toEqual(['src/c.js']);
    const md = await readFile(t.run.store.file('codemap.md'), 'utf8');
    expect(md).toContain('src/c.js (2) — purpose of src/c.js: function c');
    expect(md).toContain('src/a.js (2) — purpose of src/a.js');
    expect(t.run.state.spend.byModel).toHaveProperty(['cheap:claude-haiku-4-5-20251001']);
  });
});
