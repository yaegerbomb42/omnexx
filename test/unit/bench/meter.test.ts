import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addUsage,
  endpointFromEnv,
  rewriteBody,
  startMeter,
  usageFrom,
  type Meter,
} from '../../../bench/meter.ts';

describe('bench metering proxy', () => {
  let meter: Meter | undefined;
  const closers: (() => void)[] = [];
  afterEach(async () => {
    await meter?.close();
    for (const c of closers.splice(0)) c();
  });

  it('reads usage from a JSON body and from the last usage chunk of a stream', () => {
    expect(usageFrom('{"usage":{"prompt_tokens":10,"completion_tokens":2}}')).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
    });
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":4}}}',
      'data: [DONE]',
    ].join('\n\n');
    expect(
      addUsage({ requests: 1, prompt: 0, cached: 0, completion: 0, errors: 0 }, usageFrom(sse)),
    ).toEqual({
      requests: 1,
      prompt: 7,
      cached: 4,
      completion: 1,
      errors: 0,
    });
  });

  it('pins the model and asks streams for usage', () => {
    expect(JSON.parse(rewriteBody('{"model":"x","stream":true}', 'm'))).toEqual({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(JSON.parse(rewriteBody('{"model":"x"}', 'm'))).toEqual({ model: 'm' });
  });

  it('reads the endpoint from an env file and names a missing variable', () => {
    expect(endpointFromEnv('A_BASE_URL=https://h/v1\nA_MODEL="M"\nA_API_KEY=k\n', 'A')).toEqual({
      baseUrl: 'https://h/v1',
      model: 'M',
      apiKey: 'k',
    });
    expect(() => endpointFromEnv('A_MODEL=M', 'A')).toThrow(/A_BASE_URL/);
  });

  it('forwards with the real key and counts tokens the endpoint reports', async () => {
    const seen: { auth: string | undefined; body: string }[] = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            usage: {
              prompt_tokens: 100,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 60 },
            },
          }),
        );
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    closers.push(() => upstream.close());
    const port = (upstream.address() as AddressInfo).port;
    meter = await startMeter({
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      model: 'M',
      apiKey: 'secret',
    });
    for (let i = 0; i < 2; i++)
      await fetch(`${meter.url}/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer placeholder' },
        body: JSON.stringify({ model: 'whatever', messages: [] }),
      }).then((r) => r.json());
    expect(seen[0]?.auth).toBe('Bearer secret');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ model: 'M' });
    expect(meter.totals()).toEqual({
      requests: 2,
      prompt: 200,
      cached: 120,
      completion: 10,
      errors: 0,
    });
    meter.reset();
    expect(meter.totals().requests).toBe(0);
  });
});
