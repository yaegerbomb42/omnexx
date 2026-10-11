import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** Loopback port the browser is sent back to; fixed so a registered redirect URI stays valid. */
export const OAUTH_CALLBACK_PORT = 33418;
export const OAUTH_REDIRECT_URL = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface ServerAuth {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}
type AuthFile = Record<string, ServerAuth>;

export const oauthFile = (configHome: string): string => join(configHome, 'mcp-oauth.json');

async function readAll(configHome: string): Promise<AuthFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(oauthFile(configHome), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as AuthFile) : {};
  } catch {
    return {};
  }
}

async function update(
  configHome: string,
  server: string,
  change: (cur: ServerAuth) => ServerAuth | undefined,
): Promise<void> {
  const { [server]: cur = {}, ...rest } = await readAll(configHome);
  const next = change(cur);
  const all: AuthFile = next ? { ...rest, [server]: next } : rest;
  const file = oauthFile(configHome);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function hasTokens(configHome: string, server: string): Promise<boolean> {
  return Boolean((await readAll(configHome))[server]?.tokens);
}

/** Forget a server's login (tokens and client registration). */
export async function forgetLogin(configHome: string, server: string): Promise<void> {
  await update(configHome, server, () => undefined);
}

export interface OAuthOptions {
  /** A client registered ahead of time (servers without dynamic registration). */
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** Interactive login: show the person the sign-in page. Unset at run time, where nobody is there. */
  onRedirect?: (url: URL) => void | Promise<void>;
}

/** The secrets-file key holding a pre-registered client's secret. */
export const OAUTH_CLIENT_SECRET_KEY = 'OAUTH_CLIENT_SECRET';

/** OAuth options from a server's config and its stored secrets. */
export function oauthOptions(
  config: { oauth_client_id?: string | undefined; oauth_scope?: string | undefined },
  secrets: Record<string, string> = {},
): OAuthOptions {
  const secret = secrets[OAUTH_CLIENT_SECRET_KEY];
  return {
    ...(config.oauth_client_id ? { clientId: config.oauth_client_id } : {}),
    ...(secret ? { clientSecret: secret } : {}),
    ...(config.oauth_scope ? { scope: config.oauth_scope } : {}),
  };
}

/**
 * MCP OAuth for one server, persisted in a 0600 file beside the MCP secrets. The SDK does the
 * protocol (discovery, dynamic registration, PKCE, refresh); this stores what it hands over.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly configHome: string,
    private readonly server: string,
    private readonly opts: OAuthOptions = {},
  ) {}

  get redirectUrl(): string {
    return OAUTH_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'omnexx',
      redirect_uris: [OAUTH_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.opts.clientSecret ? 'client_secret_post' : 'none',
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  private async mine(): Promise<ServerAuth> {
    return (await readAll(this.configHome))[this.server] ?? {};
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.opts.clientId)
      return {
        client_id: this.opts.clientId,
        ...(this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {}),
      };
    return (await this.mine()).client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await update(this.configHome, this.server, (cur) => ({ ...cur, client }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.mine()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await update(this.configHome, this.server, (cur) => ({ ...cur, tokens }));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.onRedirect)
      throw new Error(
        `MCP server "${this.server}" needs you to sign in: run \`omnexx connect ${this.server}\``,
      );
    await this.opts.onRedirect(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await update(this.configHome, this.server, (cur) => ({ ...cur, verifier }));
  }

  async codeVerifier(): Promise<string> {
    const v = (await this.mine()).verifier;
    if (!v) throw new Error(`no login in progress for "${this.server}"`);
    return v;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const drop: Partial<Record<typeof scope, keyof ServerAuth>> = {
      client: 'client',
      tokens: 'tokens',
      verifier: 'verifier',
    };
    const key = drop[scope];
    await update(this.configHome, this.server, (cur) => {
      if (scope === 'all') return {};
      if (!key) return cur;
      return Object.fromEntries(Object.entries(cur).filter(([k]) => k !== key));
    });
  }
}

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>omnexx</title><body style="font:16px system-ui;padding:3em">${msg}</body>`;

/**
 * Wait for the browser to come back to the loopback redirect with `?code=`. Resolves with the
 * code; rejects on an error from the provider, a timeout, or the port being taken.
 */
export function awaitAuthCode(timeoutMs = LOGIN_TIMEOUT_MS): {
  code: Promise<string>;
  close: () => void;
} {
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    server?.closeAllConnections();
    server?.close();
  };
  const code = new Promise<string>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', OAUTH_REDIRECT_URL);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const got = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res
        .writeHead(got ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          PAGE(
            got ? 'Signed in. You can close this tab and go back to omnexx.' : 'Sign-in failed.',
          ),
        );
      close();
      if (got) resolve(got);
      else reject(new Error(`sign-in failed: ${err ?? 'no code returned'}`));
    });
    server.on('error', (e) => {
      close();
      reject(new Error(`cannot listen on ${OAUTH_REDIRECT_URL}: ${e.message}`));
    });
    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1');
    timer = setTimeout(() => {
      close();
      reject(new Error('sign-in timed out after 5 minutes'));
    }, timeoutMs);
  });
  return { code, close };
}
