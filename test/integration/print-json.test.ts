/**
 * `omnexx -p "..." --json`: one turn, one machine-readable object on stdout. The point of the
 * flag is that a script never has to scrape prose, so the test reads stdout as JSON exactly the
 * way a caller would, and checks the prose it replaces is still there without it.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';
import type { PrintResult } from '../../src/cli/print.js';
import { json, mockServer } from '../support/mock-http.js';
import { isolatedEnv, tempRepo } from '../support/tmp.js';

const REPLY = 'hi there';

function collect(s: PassThrough): () => string {
  const chunks: Buffer[] = [];
  s.on('data', (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString('utf8');
}

/** An OpenAI-compatible endpoint that streams or answers in one piece, depending on the request. */
async function chatServer(): Promise<string> {
  const srv = await mockServer((r, res) => {
    if (!r.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(r.body) as { model: string; stream?: boolean };
    const usage = { prompt_tokens: 12, completion_tokens: 4 };
    if (body.stream !== true) {
      json(res, 200, {
        id: 'c1',
        model: body.model,
        choices: [{ finish_reason: 'stop', message: { content: REPLY } }],
        usage,
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['hi ', 'there']) {
      res.write(
        `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: piece } }] })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  return srv.url;
}

async function setup(): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const cwd = await tempRepo();
  const env = await isolatedEnv();
  const base = await chatServer();
  await writeFile(
    join(cwd, 'omnexx.toml'),
    `[models]\nchat = "ep:m1"\n\n[providers.endpoints.ep]\nkind = "openai"\nbase_url = "${base}/v1"\nfree = true\n`,
  );
  return { cwd, env };
}

async function cli(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const io: CliIO = {
    stdout,
    stderr,
    stdin: Readable.from([]),
    env,
    cwd,
    isTTY: false,
    fetch: (input, init) => globalThis.fetch(input, init),
  };
  const code = await runCli(argv, io);
  return { code, stdout: out(), stderr: err() };
}

describe('omnexx -p --json', () => {
  it('prints one JSON object with the reply and the usage, and nothing else', async () => {
    const { cwd, env } = await setup();
    const r = await cli(['-p', 'say hi', '--json'], cwd, env);
    expect(r.code).toBe(0);
    // One object, so a caller can JSON.parse the whole of stdout.
    expect(r.stdout.trim().startsWith('{')).toBe(true);
    expect(r.stdout.trim().endsWith('}')).toBe(true);
    const result = JSON.parse(r.stdout) as PrintResult;
    expect(result.ok).toBe(true);
    expect(result.reply).toBe(REPLY);
    expect(result.errors).toEqual([]);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.tokens.input).toBe(12);
    expect(result.usage.tokens.output).toBe(4);
    expect(result.usage.toolCalls).toBe(0);
    // The reply is in the object, not narrated alongside it.
    expect(r.stderr).not.toContain(REPLY);
  }, 60_000);

  it('without --json still streams the prose to stdout, as before', async () => {
    const { cwd, env } = await setup();
    const r = await cli(['-p', 'say hi'], cwd, env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(REPLY);
    expect(() => JSON.parse(r.stdout) as unknown).toThrow();
  }, 60_000);
});
