import { describe, it, expect, afterEach } from 'vitest';
import { McpClientManager } from '../../../src/mcp/client-manager.js';
import { NodeStdioClientTransport } from '../../../src/mcp/stdio-transport.js';
import type { McpServerConfig } from '../../../src/config/sections/mcp.js';

/**
 * A tiny stdio MCP server that reports a few variables from its own environment. Written inline
 * so the test needs no extra fixture, and every secret below is synthetic.
 */
const ENV_PROBE_SCRIPT = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'env-probe', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'env',
      description: 'Report selected environment variables',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        anthropic: process.env.ANTHROPIC_API_KEY ?? null,
        path: process.env.PATH ?? null,
        explicit: process.env.OMNEXX_TEST_EXPLICIT ?? null,
        forwarded: process.env.OMNEXX_TEST_FORWARDED ?? null,
        hostOnly: process.env.OMNEXX_TEST_HOST_ONLY ?? null,
      }),
    },
  ],
}));

await server.connect(new StdioServerTransport());
`;

/** An MCP server that refuses to exit on its own, ignoring both stdin EOF and SIGTERM. */
const STUBBORN_SERVER_SCRIPT = `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

const HOST_SECRET = 'test-secret-do-not-leak';

function probeServerConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    command: process.execPath,
    args: ['--input-type=module', '-e', ENV_PROBE_SCRIPT],
    env: {
      OMNEXX_TEST_EXPLICIT: 'explicit-value',
      OMNEXX_TEST_FORWARDED: 'OMNEXX_TEST_HOST_ONLY',
    },
    headers_env: {},
    allow_tools: ['*'],
    inherit_env: false,
    timeout: '10s',
    ...overrides,
  };
}

interface ProbeEnv {
  anthropic: string | null;
  path: string | null;
  explicit: string | null;
  forwarded: string | null;
  hostOnly: string | null;
}

async function readChildEnv(manager: McpClientManager): Promise<ProbeEnv> {
  const result = await manager.callTool('probe', 'env', {});
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as ProbeEnv;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP stdio environment isolation', () => {
  let manager: McpClientManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.closeAll();
      manager = null;
    }
  });

  it('does not leak host secrets when inherit_env is false', async () => {
    manager = new McpClientManager(
      { probe: probeServerConfig() },
      {
        env: {
          ANTHROPIC_API_KEY: HOST_SECRET,
          OMNEXX_TEST_HOST_ONLY: 'host-only-value',
          PATH: process.env.PATH,
        },
      },
    );

    const childEnv = await readChildEnv(manager);

    expect(childEnv.anthropic).toBeNull();
    expect(childEnv.path).toBe(process.env.PATH);
    expect(childEnv.explicit).toBe('explicit-value');
    expect(childEnv.forwarded).toBe('host-only-value');
  });

  it('inherits the host environment only when inherit_env is true', async () => {
    manager = new McpClientManager(
      { probe: probeServerConfig({ inherit_env: true }) },
      {
        env: {
          ANTHROPIC_API_KEY: HOST_SECRET,
          OMNEXX_TEST_HOST_ONLY: 'host-only-value',
          PATH: process.env.PATH,
        },
      },
    );

    const childEnv = await readChildEnv(manager);

    expect(childEnv.anthropic).toBe(HOST_SECRET);
    expect(childEnv.path).toBe(process.env.PATH);
    expect(childEnv.explicit).toBe('explicit-value');
  });
});

describe('NodeStdioClientTransport.close', () => {
  it('escalates to SIGKILL when the child ignores stdin EOF and SIGTERM', async () => {
    const transport = new NodeStdioClientTransport({
      command: process.execPath,
      args: ['--input-type=module', '-e', STUBBORN_SERVER_SCRIPT],
    });

    await transport.start();
    const pid = transport.pid;
    expect(pid).not.toBeNull();
    if (pid === null) return;

    try {
      const startedAt = Date.now();
      await transport.close();
      const elapsed = Date.now() - startedAt;

      expect(isProcessAlive(pid)).toBe(false);
      // SIGTERM is ignored, so close must have waited out the grace period and killed it.
      expect(elapsed).toBeGreaterThanOrEqual(2000);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }, 20_000);
});
