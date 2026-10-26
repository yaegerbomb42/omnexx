import { describe, expect, it } from 'vitest';
import { resolvePaths, usageFile } from '../../../src/core/paths.js';
import { UsageLedger } from '../../../src/providers/usage-ledger.js';
import { cli } from '../../support/cli.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

describe('omnexx usage', () => {
  it('shows purpose, step and waste for one task, and refuses an unknown one', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    const file = usageFile(resolvePaths(env));
    const ledger = new UsageLedger(file, 'run-1', 'bench/task-01');
    ledger.recordCall(
      {
        purpose: 'main',
        taskId: 'M1.T01',
        cycle: 1,
        turn: 1,
        step: 'c1.t1',
      },
      {
        model: 'm',
        provider: 'p',
        usage: { uncached: 800, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 200, output: 50 },
        usd: 0.01,
      },
    );
    ledger.recordReadSaved({ taskId: 'M1.T01', cycle: 1, tokens: 900, path: 'a.ts', fromStep: 1 });
    const ok = await cli(['usage', 'bench/task-01'], { cwd, env });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Usage: bench/task-01');
    expect(ok.stdout).toContain('main');
    expect(ok.stdout).toContain('repeat reads of unchanged files: 1 events, 900 tokens saved');
    expect(ok.stdout).toContain('Attribution: 100.0% (1/1 calls tagged)');
    const json = await cli(['usage', 'bench/task-01', '--json'], { cwd, env });
    expect(JSON.parse(json.stdout)).toMatchObject({
      calls: 1,
      waste: { repeatRead: { tokensSaved: 900 } },
      attribution: { untagged: 0 },
    });
    const list = await cli(['usage', '--list'], { cwd, env });
    expect(list.stdout).toContain('bench/task-01');
    const missing = await cli(['usage', 'nope'], { cwd, env });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/no usage for "nope"/);
  });

  it('says so when nothing has been recorded', async () => {
    const env = await isolatedEnv();
    const r = await cli(['usage'], { cwd: await tempDir(), env });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No usage recorded yet/);
  });
});
