import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A remote MCP server behind OAuth with dynamic client registration, just enough of both
 * protocols for a client to discover, register, sign in, and list tools.
 */
export interface FakeOAuthMcp {
  url: string;
  registered: number;
  tokensIssued: number;
  close: () => Promise<void>;
}

interface Reply {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c: Buffer) => {
      s += c.toString();
    });
    req.on('end', () => {
      resolve(s);
    });
  });

const send = (res: ServerResponse, r: Reply): void => {
  const headers = {
    ...(r.json === undefined ? {} : { 'content-type': 'application/json' }),
    ...r.headers,
  };
  res.writeHead(r.status, headers).end(r.json === undefined ? undefined : JSON.stringify(r.json));
};

const RPC_RESULTS: Record<string, unknown> = {
  initialize: {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'fake', version: '1' },
  },
  'tools/list': { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] },
};

export async function startFakeOAuthMcp(): Promise<FakeOAuthMcp> {
  const state = { registered: 0, tokensIssued: 0 };
  let origin = '';

  const mcp = async (req: IncomingMessage): Promise<Reply> => {
    if (req.headers.authorization !== 'Bearer tok')
      return {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      };
    if (req.method !== 'POST') return { status: 405 };
    const msg = JSON.parse(await body(req)) as { id?: number; method: string };
    if (msg.id === undefined) return { status: 202 };
    return {
      status: 200,
      json: { jsonrpc: '2.0', id: msg.id, result: RPC_RESULTS[msg.method] ?? {} },
    };
  };

  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<Reply> | Reply> = {
    '/.well-known/oauth-authorization-server': () => ({
      status: 200,
      json: {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
    }),
    '/register': async (req) => {
      state.registered++;
      return { status: 201, json: { ...JSON.parse(await body(req)), client_id: 'client-1' } };
    },
    '/authorize': (_req, url) => {
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      return { status: 302, headers: { location: back.href } };
    },
    '/token': async (req) => {
      const form = new URLSearchParams(await body(req));
      if (form.get('code') !== 'the-code' && form.get('grant_type') !== 'refresh_token')
        return { status: 400, json: { error: 'invalid_grant' } };
      state.tokensIssued++;
      return {
        status: 200,
        json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r' },
      };
    },
    '/mcp': mcp,
  };

  const route = (req: IncomingMessage, url: URL): Promise<Reply> | Reply => {
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return { status: 200, json: { resource: `${origin}/mcp`, authorization_servers: [origin] } };
    return routes[url.pathname]?.(req, url) ?? { status: 404 };
  };

  const server = createServer((req, res) => {
    void Promise.resolve(route(req, new URL(req.url ?? '/', origin))).then((r) => {
      send(res, r);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    get registered() {
      return state.registered;
    },
    get tokensIssued() {
      return state.tokensIssued;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          r();
        });
      }),
  };
}

/** Stands in for the browser: follows the authorize redirect back to the loopback callback. */
export async function fakeBrowser(url: string): Promise<void> {
  const res = await fetch(url, { redirect: 'manual' });
  const back = res.headers.get('location');
  if (back) await fetch(back);
}
