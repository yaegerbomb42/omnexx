import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';

export interface PtyServerOptions {
  socketPath?: string | undefined;
  shell?: string | undefined;
}

export class PtyDaemon {
  private server: Server | null = null;
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly socketPath: string;
  private readonly shell: string;

  constructor(opts: PtyServerOptions = {}) {
    this.socketPath =
      opts.socketPath ??
      join(tmpdir(), `omnexx-pty-${Date.now()}-${Math.floor(Math.random() * 1000)}.sock`);
    this.shell = opts.shell ?? process.env.SHELL ?? '/bin/sh';
  }

  public getSocketPath(): string {
    return this.socketPath;
  }

  public async start(): Promise<string> {
    try {
      await unlink(this.socketPath);
    } catch {
      // Ignored if socket does not exist
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((client: Socket) => {
        const child = spawn(this.shell, ['-i'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'xterm-256color' },
        });
        this.children.add(child);

        client.pipe(child.stdin);
        child.stdout.pipe(client);
        child.stderr.pipe(client);

        let detached = false;
        const detach = (): void => {
          if (detached) return;
          detached = true;
          client.unpipe(child.stdin);
          child.stdout.unpipe(client);
          child.stderr.unpipe(client);
          this.children.delete(child);
          if (child.exitCode === null && !child.killed) {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone
            }
          }
          if (!client.destroyed) client.destroy();
        };

        child.on('exit', detach);
        child.on('error', detach);
        client.on('close', detach);
        client.on('error', detach);
      });

      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        resolve(this.socketPath);
      });
    });
  }

  public async stop(): Promise<void> {
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already stopped
      }
    }
    this.children.clear();
    if (this.server) {
      await new Promise<void>((res) => {
        this.server?.close(() => {
          res();
        });
      });
      this.server = null;
    }
    try {
      await unlink(this.socketPath);
    } catch {
      // Ignored if already unlinked
    }
  }
}

export function connectPty(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      resolve(socket);
    });
    socket.on('error', reject);
  });
}
