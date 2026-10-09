import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

export async function startFakeOAuthMcp(): Promise<FakeOAuthMcp> {
  const state = { registered: 0, tokensIssued: 0 };
  let origin = '';
  const json = (res: ServerResponse, code: number, v: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  };

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
        return;
      }
      if (url.pathname === '/register') {
        state.registered++;
        {
          json(res, 201, { ...JSON.parse(await body(req)), client_id: 'client-1' });
          return;
        }
      }
      if (url.pathname === '/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('code', 'the-code');
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.href }).end();
        return;
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await body(req));
        if (form.get('code') !== 'the-code' && form.get('grant_type') !== 'refresh_token') {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        state.tokensIssued++;
        {
          json(res, 200, {
            access_token: 'tok',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'r',
          });
          return;
        }
      }
      if (url.pathname === '/mcp') {
        if (req.headers.authorization !== 'Bearer tok') {
          res
            .writeHead(401, {
              'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            })
            .end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const msg = JSON.parse(await body(req)) as { id?: number; method: string };
        if (msg.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result =
          msg.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'fake', version: '1' },
              }
            : msg.method === 'tools/list'
              ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
              : {};
        {
          json(res, 200, { jsonrpc: '2.0', id: msg.id, result });
          return;
        }
      }
      res.writeHead(404).end();
    })();
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
