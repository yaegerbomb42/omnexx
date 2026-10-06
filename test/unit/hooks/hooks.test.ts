import { describe, expect, it } from 'vitest';
import type { HookConfig } from '../../../src/config/sections/hooks.js';
import type { ExecOptions, Executor } from '../../../src/core/exec.js';
import { HOOK_REASON_MAX, matchGlob, runHooks } from '../../../src/hooks/run.js';
import { tempDir } from '../../support/tmp.js';

/** A hook config with the default timeout; `match` is only set when given. */
const hook = (on: HookConfig['on'], run: string, match?: string): HookConfig => ({
  on,
  run,
  timeout: '30s',
  ...(match !== undefined ? { match } : {}),
});

interface Recorded {
  command: string;
  opts: ExecOptions;
}

/** Fake executor: replays canned results and records every call in order. */
function recorder(
  results: readonly { exitCode?: number; timedOut?: boolean; output?: string }[] = [],
): { exec: Executor; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const exec: Executor = (command, opts) => {
    const r = results[calls.length] ?? {};
    calls.push({ command, opts });
    return Promise.resolve({
      exitCode: r.exitCode ?? 0,
      timedOut: r.timedOut ?? false,
      aborted: false,
      output: r.output ?? '',
      durationMs: 1,
    });
  };
  return { exec, calls };
}

const shellEnv = { PATH: process.env.PATH ?? '' };

describe('runHooks', () => {
  it('a pre_commit hook exiting 1 vetoes with its stderr (real shell)', async () => {
    const cwd = await tempDir();
    const outcome = await runHooks(
      'pre_commit',
      { task: 'M1.T01' },
      {
        hooks: [hook('pre_commit', 'echo "veto: lockfile changed" >&2; exit 1')],
        cwd,
        env: shellEnv,
      },
    );
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) expect(outcome.reason).toContain('veto: lockfile changed');
    expect(outcome.ran).toHaveLength(1);
  });

  it('passes when every pre_commit hook exits 0', async () => {
    const cwd = await tempDir();
    const outcome = await runHooks(
      'pre_commit',
      { task: 'M1.T01' },
      { hooks: [hook('pre_commit', 'exit 0')], cwd, env: shellEnv },
    );
    expect(outcome.blocked).toBe(false);
    expect(outcome.ran).toHaveLength(1);
    expect(outcome.ran[0]).toMatchObject({ on: 'pre_commit', run: 'exit 0', exitCode: 0 });
  });

  it('stops at the first blocking hook and skips the rest', async () => {
    const { exec, calls } = recorder([{ exitCode: 1, output: 'nope\n' }, { exitCode: 0 }]);
    const outcome = await runHooks(
      'pre_commit',
      {},
      {
        hooks: [
          hook('pre_commit', 'first'),
          hook('pre_commit', 'second'),
          hook('cycle_end', 'third'),
        ],
        cwd: '/w',
        env: {},
        exec,
      },
    );
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) expect(outcome.reason).toContain('nope');
    expect(calls.map((c) => c.command)).toEqual(['first']);
  });

  it('passes the event in env and the payload as JSON on stdin', async () => {
    const { exec, calls } = recorder();
    const outcome = await runHooks(
      'pre_tool',
      { tool: 'bash', input: 'ls' },
      { hooks: [hook('pre_tool', 'check.sh')], cwd: '/w', env: { PATH: '/bin' }, exec },
    );
    expect(outcome.blocked).toBe(false);
    expect(calls).toHaveLength(1);
    const opts = calls[0]?.opts;
    expect(opts?.env.OMNEXX_EVENT).toBe('pre_tool');
    expect(opts?.timeoutMs).toBe(30_000);
    expect(opts?.cwd).toBe('/w');
    const parsed: unknown = JSON.parse(String(opts?.stdin));
    expect(parsed).toEqual({ tool: 'bash', input: 'ls', event: 'pre_tool' });
  });

  it('match filters tool events by tool name and is ignored elsewhere', async () => {
    const hooks = [hook('pre_tool', 'a', 'read*'), hook('pre_tool', 'b')];
    const { exec, calls } = recorder();
    await runHooks('pre_tool', { tool: 'read_file' }, { hooks, cwd: '/w', env: {}, exec });
    expect(calls.map((c) => c.command)).toEqual(['a', 'b']);
    calls.length = 0;
    await runHooks('pre_tool', { tool: 'bash' }, { hooks, cwd: '/w', env: {}, exec });
    expect(calls.map((c) => c.command)).toEqual(['b']);
    calls.length = 0;
    await runHooks(
      'cycle_end',
      {},
      {
        hooks: [hook('cycle_end', 'c', 'read*')],
        cwd: '/w',
        env: {},
        exec,
      },
    );
    expect(calls.map((c) => c.command)).toEqual(['c']);
  });

  it('never blocks on post_* or lifecycle events even when they fail', async () => {
    const cwd = await tempDir();
    for (const event of ['post_tool', 'cycle_end', 'run_end'] as const) {
      const outcome = await runHooks(
        event,
        {},
        { hooks: [hook(event, 'echo boom >&2; exit 3')], cwd, env: shellEnv },
      );
      expect(outcome.blocked).toBe(false);
    }
  });

  it('blocks a timed-out pre_* hook and says so', async () => {
    const { exec } = recorder([{ exitCode: 124, timedOut: true, output: 'partial' }]);
    const outcome = await runHooks(
      'pre_tool',
      { tool: 'bash' },
      { hooks: [hook('pre_tool', 'slow.sh')], cwd: '/w', env: {}, exec },
    );
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) expect(outcome.reason).toContain('timed out');
  });

  it('falls back to the exit code when the hook says nothing', async () => {
    const { exec } = recorder([{ exitCode: 7 }]);
    const outcome = await runHooks(
      'pre_commit',
      {},
      { hooks: [hook('pre_commit', 'silent')], cwd: '/w', env: {}, exec },
    );
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) expect(outcome.reason).toContain('exited 7');
  });

  it('trims the block reason to HOOK_REASON_MAX characters', async () => {
    const { exec } = recorder([{ exitCode: 1, output: 'x'.repeat(5_000) }]);
    const outcome = await runHooks(
      'pre_commit',
      {},
      { hooks: [hook('pre_commit', 'loud')], cwd: '/w', env: {}, exec },
    );
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) expect(outcome.reason.length).toBeLessThanOrEqual(HOOK_REASON_MAX);
  });

  it('runs nothing when no hook matches the event', async () => {
    const { exec, calls } = recorder();
    const outcome = await runHooks(
      'run_end',
      {},
      { hooks: [hook('pre_tool', 'a')], cwd: '/w', env: {}, exec },
    );
    expect(outcome).toEqual({ blocked: false, ran: [] });
    expect(calls).toHaveLength(0);
  });
});

describe('matchGlob', () => {
  it('matches with * and ? only; everything else is literal', () => {
    expect(matchGlob('read*', 'read_file')).toBe(true);
    expect(matchGlob('read*', 'write_file')).toBe(false);
    expect(matchGlob('read?', 'read')).toBe(false);
    expect(matchGlob('read?', 'reads')).toBe(true);
    expect(matchGlob('*', 'anything')).toBe(true);
    expect(matchGlob('a.b', 'axb')).toBe(false);
    expect(matchGlob('a.b', 'a.b')).toBe(true);
    expect(matchGlob('edit[1]', 'edit[1]')).toBe(true);
  });
});
