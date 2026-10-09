import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';
import type { CompletionRequest, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { makeRepo } from '../support/harness.js';
import { isolatedEnv } from '../support/tmp.js';

async function run(argv: string[], stdin = '') {
  const repo = await makeRepo({ 'a.js': 'export const a = 1;\n' });
  const seen: CompletionRequest[] = [];
  let n = 0;
  const provider: Provider = {
    name: 'anthropic',
    complete(req) {
      seen.push(req);
      n++;
      const content =
        n === 1
          ? [
              { type: 'text' as const, text: 'Let me look.' },
              { type: 'tool_use' as const, id: 'r', name: 'read', input: { path: 'a.js' } },
            ]
          : [{ type: 'text' as const, text: 'a.js exports a = 1.' }];
      return Promise.resolve({
        content,
        stopReason: n === 1 ? 'tool_use' : 'end_turn',
        usage: emptyUsage(),
        model: req.model,
      });
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (c: Buffer) => out.push(c.toString()));
  stderr.on('data', (c: Buffer) => err.push(c.toString()));
  const io: CliIO = {
    stdout,
    stderr,
    stdin: Readable.from([stdin]),
    env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
    cwd: repo,
    isTTY: false,
    makeProvider: () => provider,
  };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join(''), seen };
}

describe('omnexx -p', () => {
  it('answers on stdout, narrates on stderr, exits 0', async () => {
    const r = await run(['-p', 'what does a.js export?']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('a.js exports a = 1.\n');
    expect(r.err).toContain('thinking: Let me look.');
    expect(r.err).toContain('▸ reading a.js');
  });

  it('reads the prompt from stdin with -p -', async () => {
    const r = await run(['-p', '-'], 'summarize a.js\n');
    const first = r.seen[0]?.messages[0]?.content[0];
    expect(first?.type === 'text' && first.text).toBe('summarize a.js');
  });
});
