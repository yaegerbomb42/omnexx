import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { supervisorAlive } from '../../src/cli/commands/control.js';
import { resolvePaths } from '../../src/core/paths.js';
import { killRunChildren } from '../../src/core/process-registry.js';
import { listRunIds, RunStore } from '../../src/core/run-store.js';
import { makeRepo } from './harness.js';
import { isolatedEnv } from './tmp.js';

export const ENTRY = resolve('test/.build/process-entry.js');

/** A foreground supervisor run: `run` without --detach, or `supervise`. */
function isForegroundSupervisor(args: string[]): boolean {
  if (args[0] === 'supervise') return true;
  return args[0] === 'run' && !args.includes('--detach');
}

/**
 * Kill the registered children of every run in this env whose supervisor is no longer alive.
 * A finished run's children are orphans by definition; a live supervisor's children are left
 * alone (a --detach run keeps going after its entry process exits).
 */
export async function reapOrphanedChildren(env: NodeJS.ProcessEnv): Promise<void> {
  const paths = resolvePaths(env);
  for (const id of await listRunIds(paths)) {
    const store = new RunStore(paths, id);
    if (await supervisorAlive(store).catch(() => true)) continue;
    await killRunChildren(paths, id).catch(() => undefined);
  }
}

/** Run the bundled test entry (the real CLI with a scripted provider) as a child process. */
export function entry(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; reapChildren?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    // Own process group: on timeout the whole group goes, so a wedged supervisor cannot
    // outlive the test. (execFile cannot take `detached`, hence spawn here.)
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }, 120_000);
    timer.unref();
    child.on('error', () => {
      clearTimeout(timer);
      res({ code: 1, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      void (async () => {
        if (child.pid !== undefined) {
          try {
            process.kill(child.pid, 0);
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              // group already gone
            }
          } catch {
            // child already exited; its detached descendants are the registry's job
          }
        }
        if (opts.reapChildren !== false && isForegroundSupervisor(args)) {
          await reapOrphanedChildren(opts.env).catch(() => undefined);
        }
        res({
          code: timedOut ? 124 : (code ?? (signal ? 1 : 0)),
          stdout,
          stderr,
        });
      })();
    });
  });
}

/** A repo with omnexx.toml (node --test gate) and an env with a fake key and isolated homes. */
export async function processRepo(
  extraEnv: NodeJS.ProcessEnv = {},
  extraToml = '',
): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
  const repo = await makeRepo({
    'omnexx.toml':
      '[[gates]]\nname = "test"\nrun = "node --test --test-reporter=tap"\nparser = "node-test"\ntimeout = "2m"\n\n[review]\nenabled = false\naudit = false\nstrict_checks = false\n\n[plan]\nmode = "full"\n' +
      extraToml,
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
  fn: () => T | Promise<T | undefined>,
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
