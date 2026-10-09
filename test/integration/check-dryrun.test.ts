import { describe, expect, it } from 'vitest';
import { dryRunChecks } from '../../src/agent/check-dryrun.js';
import type { PlanUpdate } from '../../src/core/plan.js';
import { say, ScriptedProvider } from '../support/scripted-provider.js';
import { startTestRun } from '../support/harness.js';

const update = (tasks: { id: string; checks: string[]; kind?: string }[]) =>
  ({
    milestones: [{ id: 'M1', title: 'm', tasks: tasks.map((t) => ({ title: t.id, ...t })) }],
  }) as unknown as PlanUpdate;

describe('plan-time check dry runs', () => {
  it('flags checks that cannot run and tasks whose checks already pass', async () => {
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: new ScriptedProvider(() => say('unused')),
    });
    const cache = new Map<string, { exitCode: number | null; output: string }>();
    const r = await dryRunChecks(
      t.run,
      update([
        { id: 'T1', checks: ['echo "unterminated'] },
        { id: 'T2', checks: ['definitely-not-a-command-xyz'] },
        { id: 'T3', checks: ['true', 'test 1 -eq 1'] },
        { id: 'T4', checks: ['false'] },
        { id: 'T5', checks: ['true'], kind: 'investigate' },
      ]),
      cache,
    );
    expect(r.broken.map((b) => b.split(':')[0])).toEqual(['T1', 'T2']);
    expect(r.alreadyPass.map((b) => b.split(':')[0])).toEqual(['T3']);
    expect(cache.size).toBe(5);
  });
});
