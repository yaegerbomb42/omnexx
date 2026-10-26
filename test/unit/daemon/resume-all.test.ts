import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBootId } from '../../../src/daemon/boot-id.js';
import { resumableRuns } from '../../../src/daemon/resume-all.js';
import { resolvePaths, type OmnexxPaths } from '../../../src/core/paths.js';
import { RunStore, stateSchema, type RunState } from '../../../src/core/run-store.js';
import { isolatedEnv } from '../../support/tmp.js';

function runState(runId: string): RunState {
  return stateSchema.parse({
    version: 1,
    runId,
    repoRoot: '/r',
    repoName: 'r',
    worktree: '/w',
    branch: 'b',
    startRef: 's',
    lastGreen: 's',
    phase: 'act',
    status: 'running',
    cycle: 0,
    startedAt: 1,
    updatedAt: 1,
    activeMs: 0,
    goalHash: 'h',
  });
}

async function makeRun(): Promise<{ paths: OmnexxPaths; runId: string; dir: string }> {
  const paths = resolvePaths(await isolatedEnv());
  const runId = 'r_test_boot_0001';
  const store = new RunStore(paths, runId);
  await store.init();
  await store.writeState(runState(runId));
  return { paths, runId, dir: store.dir };
}

async function writeLock(dir: string, bootId: string, pid: number): Promise<void> {
  await writeFile(
    join(dir, 'lock'),
    JSON.stringify({ pid, host: hostname(), bootId, startedAt: Date.now() }),
  );
}

describe('resumableRuns', () => {
  it('resumes a stale lock from a previous boot even when the pid is alive', async () => {
    const { paths, runId, dir } = await makeRun();
    await writeLock(dir, 'previous-boot', process.pid);
    expect(await resumableRuns(paths)).toEqual([runId]);
  });

  it('skips a fresh lock whose boot id matches and whose pid is alive', async () => {
    const { paths, dir } = await makeRun();
    await writeLock(dir, await readBootId(), process.pid);
    expect(await resumableRuns(paths)).toEqual([]);
  });

  it('resumes a fresh lock whose pid is dead', async () => {
    const { paths, runId, dir } = await makeRun();
    await writeLock(dir, await readBootId(), 2 ** 22 + 12345);
    expect(await resumableRuns(paths)).toEqual([runId]);
  });
});
