import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../../../src/git/git.js';
import { firstBad, runSentinel, type SentinelCheck } from '../../../src/verify/sentinel.js';
import { tempRepo } from '../../support/tmp.js';
import { readFile } from 'node:fs/promises';

describe('firstBad', () => {
  it('finds the first failing index in O(log n) probes', async () => {
    const shas = Array.from({ length: 33 }, (_, i) => `c${i}`);
    const probed: string[] = [];
    const idx = await firstBad(shas, (s) => {
      probed.push(s);
      return Promise.resolve(Number(s.slice(1)) < 21);
    });
    expect(idx).toBe(21);
    expect(probed.length).toBeLessThanOrEqual(6);
  });

  it('returns the last index when only it is bad', async () => {
    expect(await firstBad(['a', 'b'], () => Promise.resolve(true))).toBe(1);
  });
});

async function commit(dir: string, value: string): Promise<string> {
  await writeFile(join(dir, `f-${value}.txt`), value);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', `set ${value}`]);
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
}

/** Healthy unless the "bad" marker file exists. */
const check = async (cwd: string): Promise<SentinelCheck> => {
  const bad = await readFile(join(cwd, 'f-bad.txt'), 'utf8').then(
    () => true,
    () => false,
  );
  return { pass: !bad, exitCode: bad ? 1 : 0, timedOut: false, tail: '' };
};

describe('runSentinel', { timeout: 30_000 }, () => {
  it('reports healthy without bisecting', async () => {
    const dir = await tempRepo();
    const a = await commit(dir, 'a');
    const r = await runSentinel({ cwd: dir, history: [a], check, autoRevert: true });
    expect(r).toEqual({ healthy: true, probes: 1 });
  });

  it('bisects to the culprit and reverts it with a new commit, restoring the branch', async () => {
    const dir = await tempRepo();
    const h = [await commit(dir, 'a'), await commit(dir, 'b'), await commit(dir, 'bad')];
    h.push(await commit(dir, 'c'), await commit(dir, 'd'));
    const r = await runSentinel({ cwd: dir, history: h, check, autoRevert: true });
    expect(r.healthy).toBe(false);
    expect(r.culprit).toBe(h[2]);
    expect(r.revertSha).toBeTruthy();
    expect((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('main');
    expect((await check(dir)).pass).toBe(true);
    // Original commits are untouched: the revert sits on top of the old tip.
    expect((await git(dir, ['rev-parse', 'HEAD~1'])).stdout.trim()).toBe(h[4]);
  });

  it('leaves a conflicting revert to the agent', async () => {
    const dir = await tempRepo();
    const a = await commit(dir, 'a');
    const bad = await commit(dir, 'bad');
    await writeFile(join(dir, 'f-bad.txt'), 'edited later');
    await git(dir, ['commit', '-qam', 'edit bad']);
    const tip = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
    const r = await runSentinel({ cwd: dir, history: [a, bad, tip], check, autoRevert: true });
    expect(r.culprit).toBe(bad);
    expect(r.revertSha).toBeUndefined();
    expect(r.note).toMatch(/conflict/);
    expect((await git(dir, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('only reports when auto_revert is off', async () => {
    const dir = await tempRepo();
    const h = [await commit(dir, 'a'), await commit(dir, 'bad'), await commit(dir, 'c')];
    const r = await runSentinel({ cwd: dir, history: h, check, autoRevert: false });
    expect(r.culprit).toBe(h[1]);
    expect(r.revertSha).toBeUndefined();
    expect((await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(h[2]);
  });

  it('does not revert when the run start already fails', async () => {
    const dir = await tempRepo();
    const h = [await commit(dir, 'bad'), await commit(dir, 'c')];
    const r = await runSentinel({ cwd: dir, history: h, check, autoRevert: true });
    expect(r.culprit).toBeUndefined();
    expect(r.note).toMatch(/run start/);
  });
});
