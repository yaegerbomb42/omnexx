import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyVerification,
  bindingHashes,
  writeFacts,
  type Fact,
} from '../../../src/core/facts.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { cli } from '../../support/cli.js';
import { isolatedEnv, tempRepo } from '../../support/tmp.js';

async function seeded(): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const env = await isolatedEnv();
  const cwd = await tempRepo();
  await writeFile(join(cwd, 'package.json'), '{}');
  const at = '2026-10-15T09:00:00.000Z';
  const boundTo = await bindingHashes(cwd);
  let facts: Fact[] = [];
  for (const command of ['npm test', 'npm run lint'])
    facts = applyVerification(
      facts,
      {
        kind: 'test',
        statement: `tests pass with \`${command}\``,
        command,
        source: 'gate',
        exitCode: 0,
        durationMs: 3000,
        at,
      },
      boundTo,
    );
  await writeFacts(resolvePaths(env), cwd, facts);
  return { cwd, env };
}

describe('omnexx facts', () => {
  it('lists facts, and says so when there are none', async () => {
    const { cwd, env } = await seeded();
    const r = await cli(['facts'], { cwd, env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[F1] test: tests pass with `npm test` (verified 2026-10-15, 3s)');
    expect(r.stdout).toContain('[F2]');
    const empty = await cli(['facts'], { cwd: await tempRepo(), env: await isolatedEnv() });
    expect(empty.stdout).toContain('no verified facts yet');
  });

  it('--stale lists only facts whose inputs changed', async () => {
    const { cwd, env } = await seeded();
    expect((await cli(['facts', '--stale'], { cwd, env })).stdout).toContain('no unverified facts');
    await writeFile(join(cwd, 'package.json'), '{"name":"changed"}');
    const r = await cli(['facts', '--stale', '--json'], { cwd, env });
    const shown = JSON.parse(r.stdout) as Fact[];
    expect(shown.map((f) => f.stale)).toEqual([true, true]);
  });

  it('forget <id> drops one fact; an unknown id fails', async () => {
    const { cwd, env } = await seeded();
    expect((await cli(['facts', 'forget', 'F1'], { cwd, env })).stdout).toContain('forgot F1');
    const after = await cli(['facts'], { cwd, env });
    expect(after.stdout).not.toContain('[F1]');
    expect(after.stdout).toContain('[F2]');
    expect((await cli(['facts', 'forget', 'F9'], { cwd, env })).code).toBe(1);
    expect((await cli(['facts', 'bogus'], { cwd, env })).code).toBe(1);
  });
});
