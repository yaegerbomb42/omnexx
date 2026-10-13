import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A metering proxy for head-to-head runs: every harness talks to the same OpenAI-compatible
 * endpoint through it, so tokens are counted the same way for all of them, from the endpoint's
 * own `usage` fields rather than each harness's reporting. It holds the real key; harnesses get a
 * placeholder. Streamed requests get `stream_options.include_usage` so the last chunk carries usage.
 */
export interface Endpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface MeterTotals {
  requests: number;
  prompt: number;
  cached: number;
  completion: number;
  errors: number;
}

export interface Meter {
  /** Base URL to hand a harness (ends in /v1). */
  url: string;
  totals(): MeterTotals;
  reset(): void;
  close(): Promise<void>;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

const EMPTY: MeterTotals = { requests: 0, prompt: 0, cached: 0, completion: 0, errors: 0 };

export function addUsage(t: MeterTotals, u: Usage | undefined): MeterTotals {
  if (!u) return t;
  return {
    ...t,
    prompt: t.prompt + (u.prompt_tokens ?? 0),
    cached: t.cached + (u.prompt_tokens_details?.cached_tokens ?? 0),
    completion: t.completion + (u.completion_tokens ?? 0),
  };
}

/** Usage from a JSON body or from the `data:` lines of an SSE stream (the last usage wins). */
export function usageFrom(body: string): Usage | undefined {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      return (JSON.parse(trimmed) as { usage?: Usage }).usage;
    } catch {
      return undefined;
    }
  }
  let found: Usage | undefined;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const u = (JSON.parse(data) as { usage?: Usage | null }).usage;
      if (u) found = u;
    } catch {
      // a partial or non-JSON line; skip it
    }
  }
  return found;
}

/** The request body with the pinned model and, when streaming, usage turned on. */
export function rewriteBody(raw: string, model: string): string {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const stream = body.stream === true;
    return JSON.stringify({
      ...body,
      model,
      ...(stream
        ? {
            stream_options: {
              ...(body.stream_options as Record<string, unknown> | undefined),
              include_usage: true,
            },
          }
        : {}),
    });
  } catch {
    return raw;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMeter(ep: Endpoint): Promise<Meter> {
  let totals = EMPTY;
  const upstream = ep.baseUrl.replace(/\/+$/, '');
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').replace(/^\/v1/, '');
      const raw = req.method === 'POST' ? await readBody(req) : undefined;
      const body = raw === undefined ? undefined : rewriteBody(raw, ep.model);
      totals = { ...totals, requests: totals.requests + 1 };
      try {
        const up = await fetch(`${upstream}${path}`, {
          method: req.method ?? 'GET',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${ep.apiKey}`,
            'api-key': ep.apiKey,
          },
          ...(body === undefined ? {} : { body }),
        });
        res.writeHead(up.status, {
          'content-type': up.headers.get('content-type') ?? 'application/json',
        });
        let seen = '';
        if (up.body) {
          for await (const chunk of up.body) {
            const buf = Buffer.from(chunk);
            seen += buf.toString('utf8');
            res.write(buf);
          }
        }
        res.end();
        if (up.ok) totals = addUsage(totals, usageFrom(seen));
        else totals = { ...totals, errors: totals.errors + 1 };
      } catch (err) {
        totals = { ...totals, errors: totals.errors + 1 };
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `meter: ${String(err)}` } }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    totals: () => totals,
    reset: () => {
      totals = EMPTY;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The endpoint from an env file of KEY=value lines (DEEPSEEK_BASE_URL, _MODEL, _API_KEY style). */
export function endpointFromEnv(text: string, prefix: string): Endpoint {
  const env = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) env.set(m[1], m[2].replace(/^['"]|['"]$/g, ''));
  }
  const get = (k: string): string => {
    const v = env.get(`${prefix}_${k}`);
    if (!v) throw new Error(`${prefix}_${k} missing from the endpoint env file`);
    return v;
  };
  return { baseUrl: get('BASE_URL'), model: get('MODEL'), apiKey: get('API_KEY') };
}
