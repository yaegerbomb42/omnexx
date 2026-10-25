import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { defaultSessionPool, runDisposableShell, ShellSession } from '../../../src/core/exec.js';

const env = { PATH: '/usr/bin:/bin', HOME: tmpdir() };

describe('runDisposableShell timeout / abort', () => {
  it('cancels the delayed SIGKILL once the child has exited', async () => {
    const seen: { pid: number; sig: NodeJS.Signals | number | undefined }[] = [];
    const real = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      seen.push({ pid, sig: sig as NodeJS.Signals });
      return real(pid, sig);
    });
    try {
      const r = await runDisposableShell('sleep 5', {
        cwd: tmpdir(),
        env,
        timeoutMs: 40,
        killGraceMs: 80,
      });
      expect(r.timedOut).toBe(true);
      const afterExit = seen.length;
      await new Promise((res) => setTimeout(res, 120));
      expect(seen.length).toBe(afterExit);
      expect(seen.filter((k) => k.sig === 'SIGKILL').length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('settles with aborted=true and does not leak the child', async () => {
    const ac = new AbortController();
    const p = runDisposableShell('sleep 30', {
      cwd: tmpdir(),
      env,
      signal: ac.signal,
      timeoutMs: 10_000,
      killGraceMs: 50,
    });
    ac.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
  });
});

describe('ShellSession interrupt vs next command', () => {
  afterEach(() => {
    defaultSessionPool.disposeAll();
  });

  it('does not SIGKILL the next command with a leftover reap timer', async () => {
    const s = new ShellSession('reap-race', tmpdir(), env);
    try {
      const first = await s.exec('sleep 2', { cwd: tmpdir(), env, timeoutMs: 25 });
      expect(first.timedOut).toBe(true);
      const second = await s.exec('sleep 0.15 && echo survived', {
        cwd: tmpdir(),
        env,
        timeoutMs: 2_000,
      });
      expect(second.timedOut).toBe(false);
      expect(second.output).toContain('survived');
    } finally {
      s.dispose();
    }
  });

  it('settles a follow-up command after the shell is killed', async () => {
    const s = new ShellSession('dead-shell', tmpdir(), env);
    try {
      await Promise.race([
        s.exec('kill -9 $$', { cwd: tmpdir(), env, timeoutMs: 2_000 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('kill -9 $$ hung'));
          }, 3_000),
        ),
      ]);
      const r = await Promise.race([
        s.exec('echo hello', { cwd: tmpdir(), env, timeoutMs: 2_000 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('follow-up hung'));
          }, 3_000),
        ),
      ]);
      expect(r.output).toContain('hello');
    } finally {
      s.dispose();
    }
  });
});
