import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { planNodeSchema } from '../../../src/core/plan.js';
import { git } from '../../../src/git/git.js';
import { headSha, workingTreeDiff } from '../../../src/git/repo.js';
import { detectOscillation, taskStuckSignals } from '../../../src/guard/stuck.js';
import { tempRepo } from '../../support/tmp.js';

async function commit(repo: string, files: Record<string, string>): Promise<string> {
  for (const [f, c] of Object.entries(files)) await writeFile(join(repo, f), c);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'c']);
  return headSha(repo);
}

describe('detectOscillation (A→B→A by content hash)', () => {
  it('flags a diff that restores files to an earlier green state, within one cycle', async () => {
    const repo = await tempRepo();
    const a = await commit(repo, { 'x.js': 'A\n', 'y.js': 'keep\n' });
    const b = await commit(repo, { 'x.js': 'B\n' });
    await writeFile(join(repo, 'x.js'), 'A\n');
    const { changes } = await workingTreeDiff(repo, b);
    const hit = await detectOscillation(repo, b, [b, a], changes);
    expect(hit?.signal).toBe('oscillation');
    expect(hit?.detail).toContain('x.js');
  });

  it('does not flag new content, partial reverts, or no changes', async () => {
    const repo = await tempRepo();
    const a = await commit(repo, { 'x.js': 'A\n', 'y.js': 'Y1\n' });
    const b = await commit(repo, { 'x.js': 'B\n', 'y.js': 'Y2\n' });
    await writeFile(join(repo, 'x.js'), 'C\n');
    expect(
      await detectOscillation(repo, b, [a], (await workingTreeDiff(repo, b)).changes),
    ).toBeUndefined();
    await writeFile(join(repo, 'x.js'), 'A\n');
    await writeFile(join(repo, 'y.js'), 'Y3\n');
    expect(
      await detectOscillation(repo, b, [a], (await workingTreeDiff(repo, b)).changes),
    ).toBeUndefined();
    expect(await detectOscillation(repo, b, [a], [])).toBeUndefined();
  });

  it('handles a revert that deletes a file added since the earlier green', async () => {
    const repo = await tempRepo();
    const a = await commit(repo, { 'x.js': 'A\n' });
    const b = await commit(repo, { 'new.js': 'N\n' });
    await git(repo, ['rm', '-q', 'new.js']);
    const { changes } = await workingTreeDiff(repo, b);
    expect((await detectOscillation(repo, b, [a], changes))?.signal).toBe('oscillation');
  });
});

describe('taskStuckSignals', () => {
  const stuck = defaultConfig().stuck;
  const task = (over: object) =>
    planNodeSchema.parse({ id: 'M1.T01', title: 'task', type: 'task', parentId: 'M1', ...over });
  it('fires on consecutive rejections, repeated signatures and too many cycles', () => {
    expect(taskStuckSignals(task({ consecutiveRejections: 2 }), stuck)).toEqual([]);
    expect(
      taskStuckSignals(task({ consecutiveRejections: 3 }), stuck).map((s) => s.signal),
    ).toEqual(['consecutive_rejections']);
    expect(
      taskStuckSignals(task({ failureSignatures: ['a', 'b', 'a', 'a'] }), stuck).map(
        (s) => s.signal,
      ),
    ).toEqual(['repeated_signature']);
    expect(taskStuckSignals(task({ failureSignatures: ['a', 'a', 'a', 'b'] }), stuck)).toEqual([]);
    expect(taskStuckSignals(task({ attempts: 8 }), stuck).map((s) => s.signal)).toEqual([
      'task_cycles',
    ]);
    expect(taskStuckSignals(task({ attempts: 8, status: 'done' }), stuck)).toEqual([]);
  });
});
