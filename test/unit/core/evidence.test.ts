import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evidenceText,
  isTestPath,
  rankEvidence,
  readSignals,
  type RepoSignals,
} from '../../../src/core/evidence.js';
import { git } from '../../../src/git/git.js';
import { makeRepo } from '../../support/harness.js';

const signals = (over: Partial<RepoSignals> = {}): RepoSignals => ({
  files: [
    { path: 'src/big.ts', lines: 900 },
    { path: 'src/quiet.ts', lines: 900 },
    { path: 'src/plan.ts', lines: 300 },
    { path: 'src/tiny.ts', lines: 10 },
  ],
  churn: new Map([
    ['src/big.ts', 20],
    ['src/plan.ts', 4],
  ]),
  todos: new Map([
    ['src/todo-heavy.ts', 5],
    ['src/one-todo.ts', 1],
  ]),
  tests: ['test/unit/plan.test.ts'],
  ...over,
});

describe('rankEvidence', () => {
  it('interleaves hotspots, untested files and TODO clusters, best first', () => {
    const found = rankEvidence(signals());
    expect(found.map((f) => [f.kind, f.path])).toEqual([
      ['hotspot', 'src/big.ts'],
      ['untested', 'src/quiet.ts'],
      ['todo', 'src/todo-heavy.ts'],
      ['hotspot', 'src/plan.ts'],
    ]);
  });

  it('skips paths earlier rounds were shown, small files and single TODOs', () => {
    const found = rankEvidence(signals(), new Set(['src/big.ts', 'src/todo-heavy.ts']));
    expect(found.map((f) => f.path)).toEqual(['src/plan.ts', 'src/quiet.ts']);
    expect(found.some((f) => f.path === 'src/tiny.ts' || f.path === 'src/one-todo.ts')).toBe(false);
  });

  it('counts a test named after the module, in any common convention', () => {
    const tests = ['tests/test_quiet.py', 'pkg/big_test.go'];
    const found = rankEvidence(signals({ tests }));
    expect(found.filter((f) => f.kind === 'untested').map((f) => f.path)).toEqual(['src/plan.ts']);
  });

  it('caps the list and renders one line per finding', () => {
    expect(rankEvidence(signals(), new Set(), 2)).toHaveLength(2);
    expect(evidenceText(rankEvidence(signals(), new Set(), 1))).toBe(
      '- hotspot `src/big.ts`: changed in 20 commits over 180 days, 900 lines',
    );
  });
});

describe('isTestPath', () => {
  it('recognises test files across ecosystems', () => {
    for (const p of ['test/a.ts', 'src/a.test.ts', 'a.spec.js', 'tests/test_a.py', 'a_test.go'])
      expect(isTestPath(p)).toBe(true);
    expect(isTestPath('src/contest.ts')).toBe(false);
  });
});

describe('readSignals', () => {
  it('reads churn, line counts, TODOs and tests from a git checkout', async () => {
    const repo = await makeRepo({
      'src/hot.ts': 'export const a = 1;\n'.repeat(200),
      'src/notes.ts': '// TODO: one\n// FIXME: two\nexport {};\n',
    });
    for (let i = 0; i < 3; i++) {
      await writeFile(join(repo, 'src/hot.ts'), `export const a = ${String(i)};\n`.repeat(200));
      await git(repo, ['commit', '-qam', `edit ${String(i)}`]);
    }
    const s = await readSignals(repo);
    expect(s.churn.get('src/hot.ts')).toBe(4);
    expect(s.files.find((f) => f.path === 'src/hot.ts')?.lines).toBe(201);
    expect(s.todos.get('src/notes.ts')).toBe(2);
    expect(s.tests).toContain('test/ok.test.js');
    expect(rankEvidence(s)[0]).toMatchObject({ kind: 'hotspot', path: 'src/hot.ts' });
  });

  it('returns no signals outside a git checkout', async () => {
    const s = await readSignals('/');
    expect(s.files).toEqual([]);
  });
});
