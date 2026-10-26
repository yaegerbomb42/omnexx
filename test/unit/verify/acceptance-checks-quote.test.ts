import { exec } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inferCheckCommand } from '../../../src/verify/acceptance-checks.js';

const run = (cmd: string, cwd: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    exec(cmd, { cwd, shell: '/bin/sh' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

describe('acceptance-checks shell-quoting', () => {
  it('quotes shell metacharacters from goal text inside the generated command', () => {
    expect(inferCheckCommand('No file mentions `foo" ; rm -rf src ; echo "`')).toBe(
      '! grep -rn \'foo" ; rm -rf src ; echo "\' src/ test/',
    );
    expect(inferCheckCommand('No file mentions `x$(whoami)`')).toBe(
      "! grep -rn 'x$(whoami)' src/ test/",
    );
  });

  it('executing the generated check in a temp dir leaves src/ intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acceptance-quote-'));
    try {
      await mkdir(join(dir, 'src'));
      await mkdir(join(dir, 'test'));
      await writeFile(join(dir, 'src', 'app.js'), 'module.exports = 1;\n');
      const cmd = inferCheckCommand('No file mentions `foo" ; rm -rf src ; echo "`');
      if (!cmd) throw new Error('expected a check command');
      await run(cmd, dir);
      expect(await readFile(join(dir, 'src', 'app.js'), 'utf8')).toBe('module.exports = 1;\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('goal `$(...)` text is not expanded by the shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acceptance-quote-'));
    try {
      await mkdir(join(dir, 'src'));
      await mkdir(join(dir, 'test'));
      const user = (await run('whoami', dir)).trim();
      await writeFile(join(dir, 'src', 'u.txt'), `x${user}\n`);
      const cmd = inferCheckCommand('No file mentions `x$(whoami)`');
      if (!cmd) throw new Error('expected a check command');
      await run(cmd, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
