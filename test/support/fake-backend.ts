import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkerBackend, WorkerOutcome } from '../../src/workers/types.js';

const SCRIPT = resolve('test/fixtures/workers/fake-worker.mjs');

/** A WorkerBackend over the fake worker script, driven by a scenario object. */
export function fakeBackend(
  scenarioDir: string,
  scenario: Record<string, unknown>,
  opts: { id?: string; timeoutMs?: number; cooldownMs?: number } = {},
): WorkerBackend {
  const file = join(
    scenarioDir,
    `scenario-${opts.id ?? 'fake'}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(file, JSON.stringify(scenario));
  return {
    id: opts.id ?? 'fake',
    displayName: 'Fake worker',
    timeoutMs: opts.timeoutMs ?? 20_000,
    quota: { maxRunsPerHour: 10, maxRunsPerDay: 40, cooldownMs: opts.cooldownMs ?? 3_600_000 },
    detect: () =>
      Promise.resolve({ installed: true, path: SCRIPT, version: 'fake 1.0', capabilities: [] }),
    buildInvocation: () => ({ argv: [process.execPath, SCRIPT, file], env: { FAKE_WORKER: '1' } }),
    async parseResult(exitCode, stdoutPath, stderrPath): Promise<WorkerOutcome> {
      const out = await readFile(stdoutPath, 'utf8');
      const err = await readFile(stderrPath, 'utf8');
      if (err.includes('QUOTA EXHAUSTED')) return { status: 'quota_exhausted' };
      const summary = /SUMMARY: (.*)/.exec(out)?.[1];
      return exitCode === 0
        ? { status: 'completed', ...(summary ? { summary } : {}) }
        : { status: 'failed' };
    },
  };
}

export async function writeScenario(dir: string, name: string, scenario: object): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(scenario));
  return file;
}
