import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Clock } from '../core/clock.js';
import type { RunHooks } from '../core/run.js';
import type { SuperviseOptions } from '../core/supervisor.js';
import type { Provider } from '../providers/types.js';

/** Everything a command touches in the outside world, injectable so tests drive it directly. */
export interface CliIO {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  env: NodeJS.ProcessEnv;
  cwd: string;
  isTTY: boolean;
  /** Builds the model provider from the API key. Tests inject a scripted provider here. */
  makeProvider?: (apiKey: string) => Provider;
  clock?: Clock;
  fetch?: typeof fetch;
  /** argv prefix used to start supervisors (`node dist/cli.js`); tests substitute a scripted entry. */
  entry?: string[];
  /** Phase hooks for supervisors started by this CLI (chaos tests kill at a phase). */
  hooks?: RunHooks;
  supervise?: SuperviseOptions;
}

export function processIO(): CliIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    isTTY: process.stdin.isTTY && process.stdout.isTTY,
  };
}

export function println(out: Writable, line = ''): void {
  out.write(`${line}\n`);
}

/** Read one line from stdin. Resolves `undefined` on EOF. */
export function readLine(io: CliIO, prompt: string): Promise<string | undefined> {
  io.stdout.write(prompt);
  return new Promise((resolve) => {
    const rl = createInterface({ input: io.stdin, terminal: false });
    let answered = false;
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!answered) resolve(undefined);
    });
  });
}

export async function confirm(io: CliIO, question: string): Promise<boolean> {
  const answer = await readLine(io, `${question} [y/N] `);
  return /^\s*y(es)?\s*$/i.test(answer ?? '');
}

/** Read a secret without echoing it when stdin is a TTY; plain line read when piped. */
export async function readSecret(io: CliIO, prompt: string): Promise<string | undefined> {
  const stdin = io.stdin as NodeJS.ReadStream;
  if (!io.isTTY || typeof stdin.setRawMode !== 'function') return readLine(io, prompt);
  io.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          finish(value);
          return;
        }
        if (ch === '\u0003') {
          finish(undefined);
          return;
        }
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const finish = (v: string | undefined): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      io.stdout.write('\n');
      resolve(v);
    };
    stdin.on('data', onData);
  });
}
