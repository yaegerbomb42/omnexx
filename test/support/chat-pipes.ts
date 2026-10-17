import { PassThrough } from 'node:stream';
import { serveChat, type ChatState } from '../../src/cli/chat-server.js';
import type { CliIO } from '../../src/cli/io.js';
import type { Provider } from '../../src/providers/types.js';
import { makeRepo } from './harness.js';
import { isolatedEnv } from './tmp.js';

export type Out = { type: string } & Record<string, unknown>;

/** The chat server on in-memory pipes: `send` writes one command, `until` waits for output. */
export async function chatOnPipes<P extends Provider>(provider: P) {
  const repo = await makeRepo();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: Out[] = [];
  let buf = '';
  stdout.on('data', (c: Buffer) => {
    buf += c.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) out.push(JSON.parse(l) as Out);
  });
  const io: CliIO = {
    stdout,
    stderr: new PassThrough(),
    stdin,
    env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
    cwd: repo,
    isTTY: false,
    makeProvider: () => provider,
    fetch: () => Promise.reject(new Error('no network in tests')),
  };
  let exited = false;
  const done = serveChat(io, () => Promise.resolve(0), { version: '9.9.9' }).finally(() => {
    exited = true;
  });
  const send = (cmd: Record<string, unknown>): void => {
    stdin.write(`${JSON.stringify(cmd)}\n`);
  };
  const states = (): ChatState[] => out.filter((o): o is Out & ChatState => o.type === 'state');
  const until = async <T>(fn: () => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const v = fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { repo, provider, send, out, states, until, stdin, done, exited: () => exited };
}
