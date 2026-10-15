import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findOtherToolServers,
  importPaths,
  parseJsonc,
  parsePastedServers,
} from '../../../src/integrations/importers.js';
import { tempDir } from '../../support/tmp.js';

async function put(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}

describe('pasted MCP config', () => {
  it('reads a Claude Desktop / Cursor mcpServers block', () => {
    const found = parsePastedServers(
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
          gh: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } },
        },
      }),
    );
    expect(found.map((s) => [s.name, s.command ?? s.url])).toEqual([
      ['fs', 'npx'],
      ['gh', 'https://api.githubcopilot.com/mcp/'],
    ]);
    expect(found[1]?.headers).toEqual({ Authorization: 'Bearer x' });
  });

  it('reads a VS Code servers block with comments, and a Windsurf serverUrl', () => {
    const found = parsePastedServers(`{
      // VS Code
      "servers": {
        "pw": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest"], },
        "ws": { "serverUrl": "https://mcp.example.invalid/mcp" }
      }
    }`);
    expect(found.map((s) => s.name)).toEqual(['pw', 'ws']);
    expect(found[1]?.url).toBe('https://mcp.example.invalid/mcp');
  });

  it('names a single pasted server after its package', () => {
    const [s] = parsePastedServers(
      '{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"]}',
    );
    expect(s?.name).toBe('memory');
    const [r] = parsePastedServers('{"url": "https://mcp.linear.app/mcp"}');
    expect(r?.name).toBe('linear');
  });

  it('says what is wrong with bad input', () => {
    expect(() => parsePastedServers('{ nope')).toThrow(/not valid JSON/);
    expect(() => parsePastedServers('[1]')).toThrow(/Expected a JSON object/);
    expect(() => parsePastedServers('{"mcpServers": {"x": {"args": []}}}')).toThrow(
      /needs a "command" or a "url"/,
    );
  });

  it('keeps // inside strings', () => {
    expect(parseJsonc('{"u": "https://x.invalid/a"} // c')).toEqual({ u: 'https://x.invalid/a' });
  });
});

describe('importing from VS Code, Cursor and Windsurf', () => {
  it('finds project and user-wide servers in each', async () => {
    const home = await tempDir();
    const repo = await tempDir();
    const p = importPaths({ HOME: home });
    await put(p.vscode, JSON.stringify({ servers: { vsu: { command: 'a' } } }));
    await put(
      join(repo, '.vscode', 'mcp.json'),
      '{ "servers": { "vsp": { "command": "b" } } } // c',
    );
    await put(
      join(repo, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { cp: { url: 'https://c.invalid' } } }),
    );
    await put(
      p.windsurf,
      JSON.stringify({ mcpServers: { wsf: { serverUrl: 'https://w.invalid' } } }),
    );

    const found = await findOtherToolServers({ HOME: home }, repo);

    expect(found.map((s) => `${s.name}:${s.source}`)).toEqual([
      'cp:Cursor (this project)',
      'vsp:VS Code (this project)',
      'vsu:VS Code',
      'wsf:Windsurf',
    ]);
  });
});
