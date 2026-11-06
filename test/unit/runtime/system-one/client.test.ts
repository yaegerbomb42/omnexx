import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemOneClient } from '../../../../src/runtime/system-one/client.js';
import { choice, noul, score, scoreValue } from '../../../../src/runtime/system-one/types.js';

interface Seen {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

type Handler = (seen: Seen) => { status?: number; delayMs?: number; json: unknown };

const servers: Server[] = [];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  const raw = Buffer.concat(parts).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function serve(handler: Handler): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then(async (body) => {
      const s: Seen = { path: req.url ?? '', auth: req.headers.authorization, body };
      seen.push(s);
      const out = handler(s);
      if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
      if (res.destroyed) return;
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, seen };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => {
            r();
          });
        }),
    ),
  );
});

const testKey = (): string => 'ts_' + 'a'.repeat(32);

const questions = {
  destructive: noul('Is it destructive?', { true: 'yes', false: 'no' }),
  intent: choice('What next?', { explain_code: 'explain', edit_code: 'edit' }),
  quality: score('Rate it', ['bad', 'ok', 'good']),
};

describe('SystemOneClient jev-http', () => {
  it('sends one batched /v1/systemone request with the bearer key and types every answer', async () => {
    const { url, seen } = await serve(() => ({
      json: {
        model: 'jev-1.14.0',
        answers: {
          destructive: { type: 'noul', probability: 0.97 },
          intent: {
            type: 'choice',
            choice: 'edit_code',
            probabilities: { explain_code: 1, edit_code: 3 },
          },
          quality: { type: 'score', score: 2, probabilities: { '0': 0.1, '1': 0.1, '2': 0.8 } },
        },
      },
    }));
    const key = testKey();
    const c = new SystemOneClient({
      baseUrl: `${url}/v1/systemone`,
      apiKey: key,
      timeoutMs: 2_000,
    });
    expect(c.primary).toBe('jev-http');
    const r = await c.systemOne({ state: { command: 'git push --force' }, questions });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/v1/systemone');
    expect(seen[0]?.auth).toBe(`Bearer ${key}`);
    expect(seen[0]?.body).toEqual({
      model: 'jev-latest',
      state: { command: 'git push --force' },
      questions: {
        destructive: {
          type: 'noul',
          instructions: 'Is it destructive?',
          criteria: { true: 'yes', false: 'no' },
        },
        intent: {
          type: 'choice',
          instructions: 'What next?',
          criteria: { explain_code: 'explain', edit_code: 'edit' },
        },
        quality: { type: 'score', instructions: 'Rate it', criteria: ['bad', 'ok', 'good'] },
      },
    });
    expect(r.backend).toBe('jev-http');
    expect(r.model).toBe('jev-1.14.0');
    expect(r.answers.destructive).toEqual({ type: 'noul', noul: 0.97, prob: 0.97 });
    expect(r.answers.intent.choice).toBe('edit_code');
    expect(r.answers.intent.probabilities).toEqual({ explain_code: 0.25, edit_code: 0.75 });
    expect(r.answers.intent.confidence).toBe(0.75);
    expect(scoreValue(r.answers.quality)).toBe(3);
    expect(r.answers.quality.legend).toEqual({ '0': 'bad', '1': 'ok', '2': 'good' });
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.usd).toBeGreaterThan(0);
  });

  it('memoizes identical requests (sha256 LRU): the second call costs no request', async () => {
    const { url, seen } = await serve(() => ({
      json: { answers: { q: { noul: 0.1 } } },
    }));
    const c = new SystemOneClient({ baseUrl: url, apiKey: testKey(), timeoutMs: 2_000 });
    const a = await c.noul({ state: { command: 'ls' }, question: 'destructive?' });
    const b = await c.noul({ state: { command: 'ls' }, question: 'destructive?' });
    expect(seen).toHaveLength(1);
    expect(a.prob).toBe(0.1);
    expect(b.prob).toBe(0.1);
    expect(c.stats().cacheHits).toBe(1);
  });

  it('falls back to calibrated-local when the endpoint times out', async () => {
    const { url } = await serve(() => ({ delayMs: 400, json: { answers: { q: { noul: 0.01 } } } }));
    const c = new SystemOneClient({ baseUrl: url, apiKey: testKey(), timeoutMs: 60 });
    const r = await c.noul({
      gate: 'guardrail',
      state: { command: 'rm -rf /', cwd: '/repo', repoRoot: '/repo' },
      question: 'destructive?',
    });
    expect(r.backend).toBe('calibrated-local');
    expect(r.prob).toBeGreaterThan(0.85);
    expect(c.stats().fallbacks).toBe(1);
  });

  it('falls back on HTTP errors and malformed answers', async () => {
    const { url } = await serve(() => ({ status: 500, json: {} }));
    const c = new SystemOneClient({ baseUrl: url, apiKey: testKey() });
    const r = await c.choice({
      gate: 'intent',
      state: { prompt: 'run the tests' },
      question: 'q',
      options: { run_command: 'run', edit_code: 'edit' },
    });
    expect(r.backend).toBe('calibrated-local');
    expect(r.choice).toBe('run_command');
  });
});

describe('SystemOneClient ollama-s1', () => {
  it('asks Ollama for JSON at temperature 0 (kev:4b preferred) and normalizes the answers', async () => {
    const { url, seen } = await serve((s) =>
      s.path === '/api/tags'
        ? { json: { models: [{ name: 'qwen2.5:3b' }, { name: 'kev:4b' }] } }
        : {
            json: {
              response: JSON.stringify({
                answers: {
                  destructive: { noul: 0.2 },
                  intent: { choice: 'explain_code' },
                  quality: { score: 1 },
                },
              }),
            },
          },
    );
    const c = new SystemOneClient({ backend: 'auto', ollamaUrl: url });
    expect(c.primary).toBe('ollama-s1');
    const r = await c.systemOne({ state: { x: 1 }, questions });
    expect(r.backend).toBe('ollama-s1');
    expect(r.model).toBe('ollama:kev:4b');
    const gen = seen.find((x) => x.path === '/api/generate');
    expect(gen?.body).toMatchObject({
      model: 'kev:4b',
      format: 'json',
      stream: false,
      options: { temperature: 0 },
    });
    expect(r.answers.destructive.prob).toBe(0.2);
    expect(r.answers.intent).toMatchObject({ choice: 'explain_code', confidence: 1 });
    expect(r.answers.quality.score).toBe(1);
    expect(r.usage.usd).toBe(0);
  });

  it('trips a 60s circuit breaker when Ollama is offline and answers locally', async () => {
    const { url, seen } = await serve(() => ({ status: 404, json: { error: 'no' } }));
    const c = new SystemOneClient({ ollamaUrl: url });
    await c.noul({ gate: 'guardrail', state: { command: 'git status' }, question: 'q' });
    const r = await c.noul({ gate: 'guardrail', state: { command: 'npm test' }, question: 'q' });
    expect(r.backend).toBe('calibrated-local');
    expect(seen.filter((s) => s.path === '/api/tags')).toHaveLength(1);
    expect(c.label()).toBe('System-1 Local');
  });
});

describe('SystemOneClient calibrated-local', () => {
  it('answers ad-hoc questions with honest maximum-entropy probabilities', async () => {
    const c = new SystemOneClient({ backend: 'local' });
    const r = await c.systemOne({ state: {}, questions });
    expect(r.backend).toBe('calibrated-local');
    expect(r.answers.destructive.prob).toBe(0.5);
    expect(r.answers.intent.probabilities).toEqual({ explain_code: 0.5, edit_code: 0.5 });
    expect(r.latencyMs).toBeLessThan(50);
  });

  it('rejects rubrics outside 2..10 levels', () => {
    expect(() => score('x', ['only'])).toThrow(RangeError);
  });
});
