import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRepoMcpJson } from '../../../src/mcp/config-loader.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
  vi.restoreAllMocks();
});

async function withRepo(file: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'omnexx-mcpwarn-'));
  await writeFile(join(dir, '.mcp.json'), file);
  return dir;
}

describe('loadRepoMcpJson warnings', () => {
  it('warns on .mcp.json with a trailing comma and returns empty servers', async () => {
    const repo = await withRepo(
      '{\n  "mcpServers": {\n    "demo": {\n      "command": "echo",\n    },\n  },\n}',
    );
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined);

    await expect(loadRepoMcpJson(repo)).resolves.toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('.mcp.json');
  });

  it('warns on .mcp.json with an extra key in a server entry', async () => {
    const repo = await withRepo(
      JSON.stringify({
        mcpServers: {
          demo: { command: 'echo', disabled: true },
        },
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined);

    await expect(loadRepoMcpJson(repo)).resolves.toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('.mcp.json');
  });

  it('does not warn when .mcp.json is missing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omnexx-mcpwarn-'));
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined);

    await expect(loadRepoMcpJson(dir)).resolves.toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });
});
