import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeRepo } from './harness.js';
import { isolatedEnv } from './tmp.js';

export const ENTRY = resolve('test/.build/process-entry.js');

/** Run the bundled test entry (the real CLI with a scripted provider) as a child process. */
export function entry(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [ENTRY, ...args],
      { cwd: opts.cwd, env: opts.env, timeout: 120_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        res({ code, stdout, stderr });
      },
    );
  });
}

/** A repo with omnexx.toml (node --test gate) and an env with a fake key and isolated homes. */
export async function processRepo(
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
  const repo = await makeRepo({
    'omnexx.toml':
      '[[gates]]\nname = "test"\nrun = "node --test --test-reporter=tap"\nparser = "node-test"\ntimeout = "2m"\n\n[review]\nenabled = false\naudit = false\nstrict_checks = false\n',
  });
  const { git } = await import('../../src/git/git.js');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'config', '--allow-empty']);
  const env = await isolatedEnv({
    ANTHROPIC_API_KEY: 'sk-ant-test-' + 'k'.repeat(30),
    ...extraEnv,
  });
  await writeFile(join(repo, '.git', 'info', 'exclude'), '');
  return { repo, env };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
