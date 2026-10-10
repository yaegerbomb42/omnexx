import { spawn } from 'node:child_process';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '../config/sections/mcp.js';
import { awaitAuthCode, McpOAuthProvider, oauthOptions } from './oauth.js';

const OPENERS: Partial<Record<NodeJS.Platform, (url: string) => [string, string[]]>> = {
  darwin: (url) => ['open', [url]],
  win32: (url) => ['cmd', ['/c', 'start', '', url]],
};

/** Open a URL in the default browser; failures are fine, the URL is printed too. */
export function openInBrowser(url: string): void {
  const [cmd, args] = (OPENERS[process.platform] ?? ((u: string) => ['xdg-open', [u]]))(url);
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true })
      .on('error', () => undefined)
      .unref();
  } catch {
    // The URL is printed for the person to open by hand.
  }
}

export interface SignInDeps {
  configHome: string;
  /** Header values already resolved (tokens from the secrets file). */
  headers?: Record<string, string>;
  secrets?: Record<string, string>;
  open?: (url: string) => void;
  log: (line: string) => void;
}

function transportFor(
  config: McpServerConfig,
  provider: McpOAuthProvider,
  headers: Record<string, string>,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    authProvider: provider,
    requestInit: { headers },
  });
}

async function toolCount(client: Client): Promise<number> {
  try {
    return (await client.listTools()).tools.length;
  } finally {
    await client.close();
  }
}

/**
 * Sign in to a remote MCP server in the browser and keep the tokens. Returns how many tools the
 * server offers once signed in. Already signed in: just checks the connection.
 */
export async function signIn(
  name: string,
  config: McpServerConfig,
  deps: SignInDeps,
): Promise<number> {
  if (!config.url) throw new Error(`"${name}" is a local server; it signs in on its own`);
  const wait = awaitAuthCode();
  wait.code.catch(() => undefined);
  const provider = new McpOAuthProvider(deps.configHome, name, {
    ...oauthOptions(config, deps.secrets),
    onRedirect: (url) => {
      deps.log(
        `Opening your browser to sign in to ${name}. If it does not open, visit:\n  ${url.href}`,
      );
      (deps.open ?? openInBrowser)(url.href);
    },
  });
  const headers = deps.headers ?? {};
  const first = transportFor(config, provider, headers);
  try {
    const client = new Client({ name: 'omnexx', version: '1.0.0' });
    await client.connect(first as unknown as Transport);
    wait.close();
    return await toolCount(client);
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) {
      wait.close();
      throw err;
    }
  }
  deps.log('Waiting for you to finish signing in (5 minutes)…');
  const code = await wait.code;
  await first.finishAuth(code);
  const client = new Client({ name: 'omnexx', version: '1.0.0' });
  await client.connect(transportFor(config, provider, headers) as unknown as Transport);
  return toolCount(client);
}
