import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatProcess, type ServerMessage } from '../../vscode/src/chatProcess.js';

const h = vi.hoisted(() => {
  /** The subset of vscode.EventEmitter chatProcess uses. */
  class VsEmitter<T = unknown> {
    private listeners: ((e: T) => void)[] = [];
    get event(): (fn: (e: T) => void) => { dispose(): void } {
      return (fn: (e: T) => void) => {
        this.listeners.push(fn);
        return {
          dispose: () => {
            this.listeners = this.listeners.filter((l) => l !== fn);
          },
        };
      };
    }
    fire(e: T): void {
      for (const l of [...this.listeners]) l(e);
    }
    dispose(): void {
      this.listeners = [];
    }
  }

  /** A child process that only records what the harness writes and does to it. */
  class FakeChild {
    pid = 4242;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    kill = vi.fn(() => {
      this.exitCode = 0;
    });
    stdin = {
      destroyed: false,
      writable: true,
      writes: [] as string[],
      write: (s: string) => {
        this.stdin.writes.push(s);
        return true;
      },
      end: vi.fn(),
      on: vi.fn(),
    };
    stdout = { setEncoding: vi.fn(), on: vi.fn() };
    stderr = { setEncoding: vi.fn(), on: vi.fn() };
    private listeners = new Map<string, ((e?: unknown) => void)[]>();
    on(event: string, fn: (e?: unknown) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, e?: unknown): void {
      for (const fn of this.listeners.get(event) ?? []) fn(e);
    }
  }

  return {
    VsEmitter,
    FakeChild,
    spawnMock: vi.fn(),
    engineMock: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({ spawn: h.spawnMock }));
vi.mock('../../vscode/src/engine.js', () => ({ engine: h.engineMock }));
vi.mock('vscode', () => ({ EventEmitter: h.VsEmitter }));

const ENGINE = {
  source: 'bundled',
  command: '/usr/bin/omnexx',
  prefix: [],
  env: {},
  version: '0.20.0',
  shell: false,
};

describe('chatProcess kill tree and send queue', () => {
  beforeEach(() => {
    h.spawnMock.mockReset();
    h.engineMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns detached and kills the whole process group on POSIX', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    h.engineMock.mockResolvedValue(ENGINE);
    const fake = new h.FakeChild();
    h.spawnMock.mockReturnValue(fake);

    const cp = new ChatProcess(undefined);
    cp.start();
    await vi.waitFor(() => {
      expect(h.spawnMock).toHaveBeenCalledTimes(1);
    });

    const [cmd, args, opts] = h.spawnMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe(ENGINE.command);
    expect(args).toEqual(['chat-server']);
    expect(opts.detached).toBe(true);

    cp.dispose();
    expect(killSpy).toHaveBeenCalledWith(-fake.pid, 'SIGTERM');
    // The group kill is the whole point: a plain child.kill would orphan grandchildren.
    expect(fake.kill).not.toHaveBeenCalled();

    // Let the grace-period SIGKILL timer be cancelled before the test ends.
    fake.emit('exit');
  });

  it('surfaces a send while the server is down and delivers it after a successful restart', async () => {
    h.engineMock.mockRejectedValueOnce(new Error('omnexx is not installed'));
    const cp = new ChatProcess(undefined);
    const messages: ServerMessage[] = [];
    const sub = cp.onMessage((m) => {
      messages.push(m);
    });

    cp.send({ type: 'hi' });
    await vi.waitFor(() => {
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'error', message: 'not sent — server is down' }),
      );
    });

    // The message was retained; a successful restart flushes it to stdin.
    h.engineMock.mockResolvedValue(ENGINE);
    const fake = new h.FakeChild();
    h.spawnMock.mockReturnValue(fake);
    cp.restart();
    await vi.waitFor(() => {
      expect(h.spawnMock).toHaveBeenCalledTimes(1);
    });
    fake.emit('spawn');
    await vi.waitFor(() => {
      expect(fake.stdin.writes).toContain(`${JSON.stringify({ type: 'hi' })}\n`);
    });

    sub.dispose();
  });

  it('reports unsent lines when the crash limit stops restarts, then flushes after restart', async () => {
    h.engineMock.mockResolvedValue(ENGINE);
    const cp = new ChatProcess(undefined);
    const messages: ServerMessage[] = [];
    const sub = cp.onMessage((m) => {
      messages.push(m);
    });

    // Three crashes inside the restart window hit the cap; no fourth auto-launch happens.
    for (let i = 0; i < 3; i++) {
      const fake = new h.FakeChild();
      h.spawnMock.mockReturnValue(fake);
      cp.start();
      await vi.waitFor(() => {
        expect(h.spawnMock).toHaveBeenCalledTimes(i + 1);
      });
      fake.emit('exit');
    }

    cp.send({ type: 'hi' });
    await vi.waitFor(() => {
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'error', message: 'not sent — server is down' }),
      );
    });
    expect(h.spawnMock).toHaveBeenCalledTimes(3);

    const fake = new h.FakeChild();
    h.spawnMock.mockReturnValue(fake);
    cp.restart();
    await vi.waitFor(() => {
      expect(h.spawnMock).toHaveBeenCalledTimes(4);
    });
    fake.emit('spawn');
    await vi.waitFor(() => {
      expect(fake.stdin.writes).toContain(`${JSON.stringify({ type: 'hi' })}\n`);
    });

    sub.dispose();
  });
});
