import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { runHooks } from '../../src/hooks/run.js';
import { loadInstructions, renderInstructions } from '../../src/instructions/load.js';
import { isolatedEnv, tempDir } from '../support/tmp.js';

describe('instructions and hooks end to end', () => {
  it('loads a fixture repo and lets a [[hooks]] pre_commit from omnexx.toml veto', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'OMNEXX.md'), '# OMNEXX\n\nNever commit with a red build.\n');
    await writeFile(
      join(root, 'omnexx.toml'),
      [
        '[[hooks]]',
        'on = "pre_commit"',
        `run = 'echo "blocked by policy: generated files" >&2; exit 1'`,
        '',
      ].join('\n'),
    );
    const { config } = await loadConfig({ cwd: root, env: await isolatedEnv() });
    expect(config.hooks).toHaveLength(1);

    const render = renderInstructions(await loadInstructions(root, root));
    expect(render).toContain('Never commit with a red build.');

    const outcome = await runHooks(
      'pre_commit',
      { task: 'M1.T01', cycle: 3 },
      {
        hooks: config.hooks,
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
      },
    );
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.reason).toContain('blocked by policy: generated files');
    }
    expect(outcome.ran).toHaveLength(1);
  });
});
