import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { join } from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { register } from '../../../src/cli/commands/mcp.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import type { CliIO } from '../../../src/cli/io.js';

describe('mcp CLI commands', () => {
  const tmpHome = join(process.cwd(), '.tmp-mcp-cli-test');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMNEXX_CONFIG_HOME: tmpHome,
    OMNEXX_HOME: tmpHome,
  };

  let stdout = '';
  let exitCode = 0;

  const io: CliIO = {
    stdout: {
      write: (s: string) => {
        stdout += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    stderr: {
      write: () => true,
    } as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    cwd: tmpHome,
    isTTY: false,
    env,
  };

  const setExit = (code: number) => {
    exitCode = code;
  };

  beforeEach(async () => {
    stdout = '';
    exitCode = 0;
    await mkdir(tmpHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('adds, lists, and removes stdio and url MCP servers', async () => {
    const program = new Command();
    register(program, io, setExit);

    // 1. Add stdio server
    await program.parseAsync(['node', 'test', 'mcp', 'add', 'demo-stdio', 'node', 'server.js']);
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain('Added MCP server "demo-stdio"');

    // 2. Add URL server
    const program2 = new Command();
    register(program2, io, setExit);
    await program2.parseAsync([
      'node',
      'test',
      'mcp',
      'add',
      'demo-url',
      '--url',
      'http://127.0.0.1:8000/sse',
    ]);
    expect(stdout).toContain('Added MCP server "demo-url"');

    // Verify config.toml contents
    const configPath = join(tmpHome, 'config.toml');
    const content = await readFile(configPath, 'utf8');
    expect(content).toContain('demo-stdio');
    expect(content).toContain('demo-url');

    // 3. List servers
    stdout = '';
    const program3 = new Command();
    register(program3, io, setExit);
    await program3.parseAsync(['node', 'test', 'mcp', 'list']);
    expect(stdout).toContain('demo-stdio');
    expect(stdout).toContain('demo-url');

    // 4. Remove server
    stdout = '';
    const program4 = new Command();
    register(program4, io, setExit);
    await program4.parseAsync(['node', 'test', 'mcp', 'remove', 'demo-stdio']);
    expect(stdout).toContain('Removed MCP server "demo-stdio"');

    const updated = await readFile(configPath, 'utf8');
    expect(updated).not.toContain('demo-stdio');
    expect(updated).toContain('demo-url');
  });
});
