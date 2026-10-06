import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { source, resetMcpManager } from '../../../src/tools/extra/mcp.js';
import { toolContext } from '../../support/tool-context.js';
import { workerTools } from '../../../src/tools/registry.js';
import { loadConfig } from '../../../src/config/load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeServerScript = join(__dirname, '../../fixtures/mcp/fake-server.ts');

describe('MCP Tools Source and Search Mode', () => {
  afterEach(async () => {
    await resetMcpManager();
    delete process.env.FAKE_MCP_MANY_TOOLS;
  });

  it('exposes direct tools as mcp__<server>__<tool> when <= 20 tools', async () => {
    const cwd = process.cwd();
    const { config } = await loadConfig({ cwd });
    config.mcp.servers = {
      demo: {
        command: process.execPath,
        args: ['--experimental-strip-types', fakeServerScript],
        env: [],
        headers_env: {},
        allow_tools: ['*'],
        timeout: '10s',
      },
    };

    const tools = await source.load(config);
    expect(tools.length).toBeGreaterThan(0);
    const echoTool = tools.find((t) => t.name === 'mcp__demo__echo');
    expect(echoTool).toBeDefined();

    const ctx = await toolContext(cwd);
    if (!echoTool) throw new Error('echoTool not found');
    const res = await echoTool.run({ message: 'direct call' }, ctx);
    expect(res.content).toBe('ECHO: direct call');
  });

  it('switches to mcp_search and mcp_call when > 20 tools', async () => {
    process.env.FAKE_MCP_MANY_TOOLS = '1';
    const cwd = process.cwd();
    const { config } = await loadConfig({ cwd });
    config.mcp.servers = {
      demo: {
        command: process.execPath,
        args: ['--experimental-strip-types', fakeServerScript],
        env: ['FAKE_MCP_MANY_TOOLS'],
        headers_env: {},
        allow_tools: ['*'],
        timeout: '10s',
      },
    };

    const tools = await source.load(config);
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['mcp_call', 'mcp_search']);

    const searchTool = tools.find((t) => t.name === 'mcp_search');
    const callTool = tools.find((t) => t.name === 'mcp_call');
    if (!searchTool || !callTool) throw new Error('Search mode tools missing');

    const ctx = await toolContext(cwd);
    const searchRes = await searchTool.run({ query: 'tool_5' }, ctx);
    expect(searchRes.content).toContain('mcp__demo__tool_5');

    const callRes = await callTool.run(
      { tool: 'mcp__demo__tool_5', args: { input: 'hello' } },
      ctx,
    );
    expect(callRes.content).toContain('Handled tool tool_5');
  });

  it('integrates seamlessly with workerTools registry', async () => {
    const cwd = process.cwd();
    const { config } = await loadConfig({ cwd });
    config.mcp.servers = {
      demo: {
        command: process.execPath,
        args: ['--experimental-strip-types', fakeServerScript],
        env: [],
        headers_env: {},
        allow_tools: ['echo'],
        timeout: '10s',
      },
    };

    const allTools = await workerTools(config);
    const echoTool = allTools.find((t) => t.name === 'mcp__demo__echo');
    expect(echoTool).toBeDefined();
  });
});
