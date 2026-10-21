import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';

export interface PtyServerOptions {
  socketPath?: string | undefined;
  shell?: string | undefined;
}

export class PtyDaemon {
  private server: Server | null = null;
  private child: ChildProcess | null = null;
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
        this.child = spawn(this.shell, ['-i'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'xterm-256color' },
        });

        if (this.child.stdin) {
          client.pipe(this.child.stdin);
        }
        if (this.child.stdout) {
          this.child.stdout.pipe(client);
        }
        if (this.child.stderr) {
          this.child.stderr.pipe(client);
        }

        this.child.on('exit', () => {
          client.end();
        });

        client.on('error', () => {
          this.child?.kill();
        });
      });

      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        resolve(this.socketPath);
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // already stopped
      }
      this.child = null;
    }
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
