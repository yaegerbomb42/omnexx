import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpClientManager } from '../../../src/mcp/client-manager.js';
import {
  formatMcpToolName,
  normalizeMcpSchema,
  trimMcpOutput,
} from '../../../src/mcp/normalizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeServerScript = join(__dirname, '../../fixtures/mcp/fake-server.ts');

describe('MCP Normalizer', () => {
  it('formats tool names cleanly', () => {
    expect(formatMcpToolName('local-fs', 'read_file')).toBe('mcp__local-fs__read_file');
    expect(formatMcpToolName('my server', 'list.files')).toBe('mcp__my_server__list_files');
  });

  it('normalizes schemas and sorts keys', () => {
    const raw = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        z: { type: 'string' },
        a: { type: 'number' },
      },
    };
    const norm = normalizeMcpSchema(raw);
    expect(Object.prototype.hasOwnProperty.call(norm, '$schema')).toBe(false);
    expect(Object.keys(norm)).toEqual(['properties', 'type']);
    const properties = norm.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(['a', 'z']);
  });

  it('trims oversized MCP text output', () => {
    const shortText = 'hello world';
    expect(trimMcpOutput(shortText)).toBe(shortText);

    const longText = 'a'.repeat(30_000);
    const trimmed = trimMcpOutput(longText);
    expect(trimmed.length).toBeLessThan(longText.length);
    expect(trimmed).toContain('[6000 characters omitted due to token cap]');
  });
});

describe('MCP Client Manager', () => {
  let manager: McpClientManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.closeAll();
      manager = null;
    }
  });

  it('connects to stdio fake server, lists tools, and calls tool', async () => {
    manager = new McpClientManager({
      fake: {
        command: process.execPath,
        args: ['--experimental-strip-types', fakeServerScript],
        env: [],
        headers_env: {},
        allow_tools: ['*'],
        inherit_env: false,
        timeout: '10s',
      },
    });

    const tools = await manager.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain('echo');

    const result = await manager.callTool('fake', 'echo', { message: 'vitest test' });
    expect(result.content[0]?.text).toBe('ECHO: vitest test');
  });

  it('filters tools by allow_tools pattern', async () => {
    manager = new McpClientManager({
      fake: {
        command: process.execPath,
        args: ['--experimental-strip-types', fakeServerScript],
        env: [],
        headers_env: {},
        allow_tools: ['echo'],
        inherit_env: false,
        timeout: '10s',
      },
    });

    const tools = await manager.listTools();
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe('echo');
  });

  it('restarts server once on crash during tool call', async () => {
    manager = new McpClientManager({
      fake: {
        command: process.execPath,
        args: ['--experimental-strip-types', fakeServerScript],
        env: ['FAKE_MCP_CRASH_FIRST'],
        headers_env: {},
        allow_tools: ['*'],
        inherit_env: false,
        timeout: '10s',
      },
    });

    process.env.FAKE_MCP_CRASH_FIRST = '1';
    try {
      const res = await manager.callTool('fake', 'crash_or_greet', { name: 'Alice' });
      expect(res.content[0]?.text).toBe('Hello Alice');
    } finally {
      delete process.env.FAKE_MCP_CRASH_FIRST;
    }
  });
});
