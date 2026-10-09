import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NodeStdioClientTransport } from './stdio-transport.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '../config/sections/mcp.js';
import { matchesAny } from '../security/glob.js';
import { SECRET_PREFIX, type McpSecrets } from '../integrations/secrets.js';

/** What every stdio server gets from the host environment, whatever its config says. */
const BASE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'DOCKER_HOST',
];

/** Package-manager settings (cache, registry, proxy) that npx / uvx servers need to install. */
const BASE_ENV_PREFIXES = ['npm_config_', 'NPM_CONFIG_', 'UV_', 'PIP_'];

export interface McpClientOptions {
  /** The environment to read from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Stored secrets by server, for `secret:<KEY>` values in env and headers. */
  secrets?: McpSecrets;
}

export interface McpToolInfo {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: {
    type: string;
    text?: string | undefined;
    data?: string | undefined;
    mimeType?: string | undefined;
  }[];
  isError?: boolean | undefined;
}

interface ServerInstance {
  config: McpServerConfig;
  client?: Client | null;
  transport?: Transport | null;
  crashedOnce: boolean;
  connected: boolean;
}

export class McpClientManager {
  private servers = new Map<string, ServerInstance>();
  private toolCache: McpToolInfo[] | null = null;

  private readonly env: NodeJS.ProcessEnv;
  private readonly secrets: McpSecrets;

  constructor(serverConfigs: Record<string, McpServerConfig>, opts: McpClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.secrets = opts.secrets ?? {};
    for (const [name, cfg] of Object.entries(serverConfigs)) {
      this.servers.set(name, {
        config: cfg,
        crashedOnce: false,
        connected: false,
      });
    }
  }

  /**
   * A configured value: `secret:<KEY>` reads the server's stored secret, a name of a set env var
   * reads that variable, anything else is used as is.
   */
  private resolveValue(server: string, ref: string): string | undefined {
    if (ref.startsWith(SECRET_PREFIX))
      return this.secrets[server]?.[ref.slice(SECRET_PREFIX.length)];
    return this.env[ref] ?? ref;
  }

  private resolveEnv(
    server: string,
    envConfig: string[] | Record<string, string>,
  ): Record<string, string> {
    const env: Record<string, string> = {};
    if (Array.isArray(envConfig)) {
      for (const key of envConfig) {
        const val = this.env[key];
        if (typeof val === 'string') env[key] = val;
      }
    } else {
      for (const [targetKey, ref] of Object.entries(envConfig)) {
        const val = this.resolveValue(server, ref);
        if (val !== undefined) env[targetKey] = val;
      }
    }
    return env;
  }

  private resolveHeaders(
    server: string,
    headersEnv: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [headerName, ref] of Object.entries(headersEnv)) {
      const val = this.resolveValue(server, ref);
      if (val !== undefined) headers[headerName] = val;
    }
    return headers;
  }

  /** The environment a stdio server starts with. */
  serverEnv(server: string, config: McpServerConfig): Record<string, string> {
    const base: Record<string, string> = {};
    if (config.inherit_env) {
      for (const [k, v] of Object.entries(this.env)) if (typeof v === 'string') base[k] = v;
    } else {
      for (const [k, v] of Object.entries(this.env))
        if (
          typeof v === 'string' &&
          (BASE_ENV.includes(k) || BASE_ENV_PREFIXES.some((p) => k.startsWith(p)))
        )
          base[k] = v;
    }
    return { ...base, ...this.resolveEnv(server, config.env) };
  }

  private async connectServer(name: string, instance: ServerInstance): Promise<Client> {
    if (instance.client && instance.connected) {
      return instance.client;
    }

    const { config } = instance;
    const client = new Client({ name: `omnexx-${name}`, version: '1.0.0' }, { capabilities: {} });

    let transport: Transport;

    if (config.command) {
      transport = new NodeStdioClientTransport({
        command: config.command,
        args: config.args,
        env: this.serverEnv(name, config),
      });
    } else if (config.url) {
      const headers = this.resolveHeaders(name, config.headers_env);
      const url = new URL(config.url);
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      }) as unknown as Transport;
    } else {
      throw new Error(`MCP server "${name}" has neither command nor url specified`);
    }

    transport.onerror = () => {
      instance.connected = false;
      if (!instance.crashedOnce) {
        instance.crashedOnce = true;
        void this.restartServer(name).catch(() => {
          // ignore error on crash restart
        });
      }
    };

    await client.connect(transport);
    instance.client = client;
    instance.transport = transport;
    instance.connected = true;

    return client;
  }

  private async restartServer(name: string): Promise<Client | undefined> {
    const instance = this.servers.get(name);
    if (!instance) return undefined;

    try {
      if (instance.transport) {
        await instance.transport.close();
      }
    } catch {
      // ignore close errors
    }

    instance.connected = false;
    instance.client = null;
    instance.transport = null;

    return this.connectServer(name, instance);
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (this.toolCache) return this.toolCache;

    const allTools: McpToolInfo[] = [];

    for (const [serverName, instance] of this.servers.entries()) {
      try {
        const client = await this.connectServer(serverName, instance);
        const result = await client.listTools();

        const allowedGlobs = instance.config.allow_tools;

        for (const t of result.tools) {
          if (allowedGlobs.length > 0 && !matchesAny(t.name, allowedGlobs)) {
            continue;
          }
          allTools.push({
            serverName,
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema,
          });
        }
      } catch {
        // Soft fail if server cannot connect or list tools
      }
    }

    this.toolCache = allTools;
    return allTools;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const instance = this.servers.get(serverName);
    if (!instance) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    const execute = async (client: Client): Promise<McpCallResult> => {
      const response = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return response as McpCallResult;
    };

    try {
      const client = await this.connectServer(serverName, instance);
      return await execute(client);
    } catch (err) {
      if (!instance.crashedOnce) {
        instance.crashedOnce = true;
        const restartedClient = await this.restartServer(serverName);
        if (restartedClient) {
          return await execute(restartedClient);
        }
      }
      throw err;
    }
  }

  async closeAll(): Promise<void> {
    for (const instance of this.servers.values()) {
      try {
        if (instance.transport) {
          await instance.transport.close();
        }
      } catch {
        // ignore
      }
      instance.connected = false;
      instance.client = null;
      instance.transport = null;
    }
    this.toolCache = null;
  }
}
