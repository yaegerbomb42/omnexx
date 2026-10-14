import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile } from 'node:fs/promises';

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

/** The first words of a request's system prompt: enough to tell worker, reviewer and auditor apart. */
export function callLabel(raw: string): string {
  try {
    const body = JSON.parse(raw) as { messages?: { role?: string; content?: unknown }[] };
    const sys = body.messages?.find((m) => m.role === 'system')?.content;
    const text = typeof sys === 'string' ? sys : JSON.stringify(sys ?? '');
    return text.replace(/\s+/g, ' ').slice(0, 60);
  } catch {
    return '';
  }
}

/** With `log`, one JSON line per call (label and usage) is appended there. */
export async function startMeter(ep: Endpoint, log?: string): Promise<Meter> {
  let totals = EMPTY;
  const upstream = withoutTrailingSlashes(ep.baseUrl);
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = forwardPath(req.url);
      if (!path) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'meter: not an OpenAI API path' } }));
        return;
      }
      const raw = req.method === 'POST' ? await readBody(req) : undefined;
      const body = raw === undefined ? undefined : rewriteBody(raw, ep.model);
      const dump = process.env.BENCH_METER_DUMP;
      if (dump && body !== undefined) await appendFile(dump, `${body}\n`);
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
        const usage = usageFrom(seen);
        if (up.ok) totals = addUsage(totals, usage);
        else totals = { ...totals, errors: totals.errors + 1 };
        if (log && raw !== undefined)
          await appendFile(
            log,
            `${JSON.stringify({ at: Date.now(), label: callLabel(raw), status: up.status, usage })}\n`,
          );
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

/** Only these API paths are forwarded upstream; anything else is refused. */
const FORWARDED = new Set(['/chat/completions', '/completions', '/models', '/embeddings']);

/** The upstream path for a request ("/v1/chat/completions" → "/chat/completions"), or undefined. */
export function forwardPath(url: string | undefined): string | undefined {
  const pathname = new URL(url ?? '/', 'http://meter.local').pathname;
  const path = pathname.startsWith('/v1/') ? pathname.slice(3) : pathname;
  return FORWARDED.has(path) ? path : undefined;
}

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/** The endpoint from environment variables PREFIX_BASE_URL, PREFIX_MODEL and PREFIX_API_KEY. */
export function endpointFromEnv(env: NodeJS.ProcessEnv, prefix: string): Endpoint {
  const get = (k: string): string => {
    const v = env[`${prefix}_${k}`]?.trim();
    if (!v) throw new Error(`${prefix}_${k} is not set`);
    return v;
  };
  return { baseUrl: get('BASE_URL'), model: get('MODEL'), apiKey: get('API_KEY') };
}
