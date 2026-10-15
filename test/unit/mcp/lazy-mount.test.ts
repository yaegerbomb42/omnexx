import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/tokens.js';
import type { McpClientManager, McpToolInfo } from '../../../src/mcp/client-manager.js';
import { mcpToolTokens, mountsLazily, readMounted, MOUNTED_FILE } from '../../../src/mcp/mount.js';
import { lazyMcpTools } from '../../../src/tools/extra/mcp-lazy.js';
import { toolSpec } from '../../../src/tools/registry.js';
import type { Tool, ToolContext } from '../../../src/tools/types.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

/** A tool shaped like a real one (GitHub / Playwright style): five described params, two required. */
function realisticTool(serverName: string, i: number): McpToolInfo {
  const param = (what: string) => ({
    type: 'string',
    description: `The ${what} to use for this operation. Must be a valid value as documented by the server; see the server's README for the accepted formats and limits.`,
  });
  return {
    serverName,
    name: `operation_${i}`,
    description: `Performs operation ${i} against the ${serverName} service. Returns a JSON document describing the result, including identifiers, timestamps and any pagination cursor needed to fetch more results.`,
    inputSchema: {
      type: 'object',
      properties: {
        owner: param('owner'),
        repo: param('repository'),
        query: param('query'),
        page: { type: 'number', description: 'Page number for paginated results (1-based).' },
        per_page: { type: 'number', description: 'Results per page, at most 100.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  };
}

const SERVERS = ['github', 'playwright', 'postgres', 'linear'];
const TOOLS_PER_SERVER = 20;
const ALL = SERVERS.flatMap((s) =>
  Array.from({ length: TOOLS_PER_SERVER }, (_, i) => realisticTool(s, i)),
);

const specTokens = (tools: readonly Tool[]) => estimateTokens(JSON.stringify(tools.map(toolSpec)));

function fakeManager(calls: unknown[]): McpClientManager {
  return {
    callTool: (server: string, tool: string, args: unknown) => {
      calls.push({ server, tool, args });
      return Promise.resolve({ content: [{ type: 'text', text: `ran ${server}/${tool}` }] });
    },
  } as unknown as McpClientManager;
}

async function ctxFor(): Promise<ToolContext> {
  return toolContext(await tempDir('omnexx-lazy-mcp-'));
}

const byName = (tools: readonly Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe('lazy MCP mounting', () => {
  it('sends a small fraction of the schema tokens for 80 realistic tools', () => {
    const before = mcpToolTokens(ALL);
    const after = specTokens(lazyMcpTools(fakeManager([]), ALL));
    // 80 tools of this size cost ~20k tokens per request; the two lazy tools a few hundred.
    expect(before).toBeGreaterThan(15_000);
    expect(after).toBeLessThan(600);
    expect(after / before).toBeLessThan(0.04);
  });

  it('chooses eager when configured or when all tools are cheap', () => {
    const lazy = { mount: 'lazy' as const, eager_under_tokens: 3000 };
    expect(mountsLazily(lazy, ALL)).toBe(true);
    expect(mountsLazily(lazy, ALL.slice(0, 3))).toBe(false);
    expect(mountsLazily({ ...lazy, mount: 'eager' }, ALL)).toBe(false);
  });

  it('lists every server once with its tool count in the mcp description', () => {
    const mount = byName(lazyMcpTools(fakeManager([]), ALL), 'mcp');
    for (const s of SERVERS) expect(mount.description).toContain(`- ${s} (20 tools):`);
  });

  it('keeps the tool specs byte-identical after mounting, so the cached prefix never moves', async () => {
    const ctx = await ctxFor();
    const tools = lazyMcpTools(fakeManager([]), ALL);
    const before = JSON.stringify(tools.map(toolSpec));
    const res = await byName(tools, 'mcp').run({ server: 'github' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"tool":"operation_0"');
    expect(res.content).toContain('"required":["owner","repo"]');
    expect(JSON.stringify(lazyMcpTools(fakeManager([]), ALL).map(toolSpec))).toBe(before);
  });

  it('refuses a call to a server that is not mounted', async () => {
    const calls: unknown[] = [];
    const call = byName(lazyMcpTools(fakeManager(calls), ALL), 'mcp_call');
    const res = await call.run(
      { server: 'github', tool: 'operation_1', args: { owner: 'a', repo: 'b' } },
      await ctxFor(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not mounted');
    expect(calls).toEqual([]);
  });

  it('calls a mounted tool, and the mount survives a fresh tool list (next cycle, compaction)', async () => {
    const ctx = await ctxFor();
    await byName(lazyMcpTools(fakeManager([]), ALL), 'mcp').run({ server: 'linear' }, ctx);
    const calls: unknown[] = [];
    const call = byName(lazyMcpTools(fakeManager(calls), ALL), 'mcp_call');
    const args = { owner: 'a', repo: 'b', page: 2 };
    const res = await call.run({ server: 'linear', tool: 'operation_3', args }, ctx);
    expect(res.content).toBe('ran linear/operation_3');
    expect(calls).toEqual([{ server: 'linear', tool: 'operation_3', args }]);
    expect(await readMounted(ctx.store.file(MOUNTED_FILE))).toEqual(['linear']);
  });

  it('rejects args that do not fit the schema and shows the schema', async () => {
    const ctx = await ctxFor();
    const calls: unknown[] = [];
    const tools = lazyMcpTools(fakeManager(calls), ALL);
    await byName(tools, 'mcp').run({ server: 'github' }, ctx);
    const res = await byName(tools, 'mcp_call').run(
      { server: 'github', tool: 'operation_0', args: { owner: 'a', page: 'two' } },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('repo');
    expect(res.content).toContain('Schema:');
    expect(calls).toEqual([]);
  });

  it('names the installed servers when asked to mount an unknown one', async () => {
    const res = await byName(lazyMcpTools(fakeManager([]), ALL), 'mcp').run(
      { server: 'nope' },
      await ctxFor(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('github, linear, playwright, postgres');
  });
});
