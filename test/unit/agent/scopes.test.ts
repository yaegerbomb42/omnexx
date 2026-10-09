import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  heatmap,
  notesCap,
  readScopeNotes,
  renderScope,
  writeScopeNotes,
  type ScopeEnv,
} from '../../../src/agent/scopes.js';
import { RunStore } from '../../../src/core/run-store.js';
import { git } from '../../../src/git/git.js';
import { tempDir, tempRepo } from '../../support/tmp.js';

async function commit(repo: string, file: string, body: string): Promise<void> {
  await writeFile(join(repo, file), body);
  await git(repo, ['add', file]);
  await git(repo, ['commit', '-qm', `touch ${file}`]);
}

function env(repoRoot: string, home: string, runId: string): ScopeEnv {
  return { store: new RunStore({ home, configHome: home }, runId), repoRoot };
}

describe('context scopes', () => {
  it('keeps general and repo notes across runs, but heat and recent notes stay with the run', async () => {
    // Arrange
    const repo = await tempRepo();
    const home = await tempDir();
    const first = env(repo, home, 'r_1');
    const second = env(repo, home, 'r_2');

    // Act
    await writeScopeNotes(first, 'repo', 'API lives in src/api; tests mirror it');
    await writeScopeNotes(first, 'recent', 'halfway through the parser');

    // Assert
    expect(await readScopeNotes(second, 'repo')).toBe('API lives in src/api; tests mirror it');
    expect(await readScopeNotes(second, 'recent')).toBe('');
    expect(await readScopeNotes(first, 'recent')).toBe('halfway through the parser');
  });

  it('clips notes to the scope cap and shows them first in the scope', async () => {
    const e = env(await tempRepo(), await tempDir(), 'r_1');
    const stored = await writeScopeNotes(e, 'heat', 'x'.repeat(notesCap('heat') + 500));
    expect(stored).toHaveLength(notesCap('heat'));
    expect(await renderScope(e, 'heat')).toMatch(/^## Your heat notes\nx+/);
  });

  it('ranks files by recent churn, with uncommitted and edited files on top', async () => {
    const repo = await tempRepo();
    await commit(repo, 'a.ts', '1');
    await commit(repo, 'a.ts', '2');
    await commit(repo, 'b.ts', '1');
    await writeFile(join(repo, 'c.ts'), 'new');
    await git(repo, ['add', 'c.ts']);

    const lines = (await heatmap(repo, new Set(['b.ts']))).split('\n');

    expect(lines[0]).toBe('b.ts  11 (edited here)');
    expect(lines[1]).toBe('c.ts  5 (uncommitted)');
    expect(lines[2]).toBe('a.ts  2');
  });

  it('says a scope is empty instead of returning nothing', async () => {
    const e = env(await tempRepo(), await tempDir(), 'r_1');
    expect(await renderScope(e, 'recent')).toBe('the recent scope is empty');
  });
});
