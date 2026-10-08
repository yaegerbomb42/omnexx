import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baselineBlock } from '../../../src/agent/planner.js';
import type { Run } from '../../../src/core/run.js';
import type { Baseline } from '../../../src/core/run-store.js';

async function fakeRun(baseline: Baseline | undefined, logs: Record<string, string> = {}) {
  const logsDir = await mkdtemp(join(tmpdir(), 'omnexx-baseline-'));
  for (const [name, text] of Object.entries(logs))
    await writeFile(join(logsDir, `gate-baseline-${name}.log`), text);
  return {
    state: { baseline },
    store: { logsDir },
    redactor: { text: (s: string) => s.replaceAll('sk-secret', '[redacted]') },
  } as unknown as Run;
}

describe('baselineBlock', () => {
  it('is empty before any baseline ran', async () => {
    expect(await baselineBlock(await fakeRun(undefined))).toBe('');
    expect(await baselineBlock(await fakeRun({}))).toBe('');
  });

  it('lists passing gates briefly and failing ones with ids and a redacted log tail', async () => {
    const log = [...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'TS2339 sk-secret'].join(
      '\n',
    );
    const text = await baselineBlock(
      await fakeRun(
        {
          lint: { exitCode: 0, timedOut: false, failureIds: [] },
          test: {
            exitCode: 1,
            timedOut: false,
            failureIds: ['utils > adds'],
            tests: { total: 3, passed: 2, failed: 1, skipped: 0 },
          },
          slow: { exitCode: 124, timedOut: true, failureIds: [] },
        },
        { test: log },
      ),
    );
    expect(text).toContain('- lint: passes');
    expect(text).toContain('- test: exit 1, tests 2/3 passing; failing: utils > adds');
    expect(text).toContain('- slow: timed out');
    expect(text).toContain('TS2339 [redacted]');
    expect(text).not.toContain('line 15\n');
    expect(text).toContain('line 16');
  });
});
