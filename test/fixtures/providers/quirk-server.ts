import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach } from 'vitest';

/** Every flag defaults off, so the server is an ordinary chat-completions endpoint. */
export interface QuirkOptions {
  /** A tool-call message is sent with `content: null`. */
  nullToolContent?: boolean;
  /** 400 when the body still contains `max_tokens`. */
  rejectMaxTokens?: boolean;
  /** The first response is 429 with this `Retry-After` (seconds). Later calls succeed. */
  retryAfterSeconds?: number;
  /** One SSE JSON event is written as two socket chunks. */
  splitStream?: boolean;
  /** HTTP 200 with `choices: []`. */
  emptyChoices?: boolean;
  /** HTTP 400 whose message names this field, on every request. */
  unknownField?: string;
  /** Two tool calls in one message share an id. */
  duplicateToolCallId?: boolean;
}

export interface QuirkRequest {
  method: string;
  url: string;
  body: string;
}

export interface QuirkServer {
  /** `http://127.0.0.1:<port>` — no network beyond loopback. */
  url: string;
  requests: QuirkRequest[];
  close: () => Promise<void>;
}

const USAGE = { prompt_tokens: 12, completion_tokens: 3 };
const open: Server[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => closeServer(server)));
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res
    .writeHead(status, { 'content-type': 'application/json', ...headers })
    .end(JSON.stringify(body));
}

function message(quirks: QuirkOptions): {
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
} {
  if (quirks.duplicateToolCallId)
    return {
      content: '',
      tool_calls: [
        { id: 'call_same', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
        { id: 'call_same', type: 'function', function: { name: 'write', arguments: '{"path":"b"}' } },
      ],
    };
  if (quirks.nullToolContent)
    return {
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
      ],
    };
  return { content: 'ok' };
}

function completion(quirks: QuirkOptions): unknown {
  const tools = Boolean(quirks.nullToolContent || quirks.duplicateToolCallId);
  return {
    model: 'quirk-model',
    choices: [
      {
        finish_reason: tools ? 'tool_calls' : 'stop',
        message: message(quirks),
      },
    ],
    usage: USAGE,
  };
}

function sse(text: string): string {
  return (
    `data: ${JSON.stringify({ model: 'quirk-model', choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE })}\n\n` +
    `data: [DONE]\n\n`
  );
}

/** Write one SSE event in two chunks so a line buffer has to reassemble the JSON. */
async function writeSplit(res: ServerResponse, text: string): Promise<void> {
  const event = `data: ${JSON.stringify({
    model: 'quirk-model',
    choices: [{ delta: { content: text } }],
  })}\n\n`;
  const cut = event.indexOf('{') + 1;
  const rest =
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE })}\n\n` +
    `data: [DONE]\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.socket?.setNoDelay(true);
  res.write(event.slice(0, cut));
  await delay(20);
  res.end(event.slice(cut) + rest);
}

async function respond(
  res: ServerResponse,
  quirks: QuirkOptions,
  body: Record<string, unknown>,
  hits: { n: number },
): Promise<void> {
  hits.n += 1;
  if (quirks.unknownField) {
    json(res, 400, { error: { message: `Unknown parameter: '${quirks.unknownField}'.` } });
    return;
  }
  if (quirks.retryAfterSeconds !== undefined && hits.n === 1) {
    json(res, 429, { error: { message: 'slow down' } }, {
      'retry-after': String(quirks.retryAfterSeconds),
    });
    return;
  }
  if (quirks.rejectMaxTokens && 'max_tokens' in body) {
    json(res, 400, {
      error: {
        message:
          "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      },
    });
    return;
  }
  if (quirks.emptyChoices) {
    json(res, 200, { model: 'quirk-model', choices: [], usage: USAGE });
    return;
  }
  if (body.stream === true) {
    if (quirks.splitStream) {
      await writeSplit(res, 'reassembled');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse('ok'));
    return;
  }
  json(res, 200, completion(quirks));
}

/** Loopback OpenAI-compatible chat completions. One option turns on one quirk. */
export async function quirkServer(quirks: QuirkOptions = {}): Promise<QuirkServer> {
  const requests: QuirkRequest[] = [];
  const hits = { n: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(rec);
      const path = rec.url.split('?')[0] ?? '';
      if (rec.method !== 'POST' || !path.endsWith('/chat/completions')) {
        res.writeHead(404).end('not found');
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(rec.body) as Record<string, unknown>;
      } catch {
        json(res, 400, { error: { message: 'body was not JSON' } });
        return;
      }
      void respond(res, quirks, body, hits).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(err instanceof Error ? err.message : 'quirk server failed');
      });
    });
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: async () => {
      const i = open.indexOf(server);
      if (i >= 0) open.splice(i, 1);
      await closeServer(server);
    },
  };
}
