import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { CommandRegistrar } from './extra/types.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import { println, type CliIO } from '../io.js';
import { EXIT } from '../exit-codes.js';
import { McpClientManager } from '../../mcp/client-manager.js';
import { resolveMcpServers } from '../../mcp/config-loader.js';
import { loadConfig } from '../../config/load.js';

interface TomlConfig {
  mcp?: {
    servers?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

async function loadUserToml(configPath: string): Promise<TomlConfig> {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed: unknown = parseToml(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as TomlConfig) : {};
  } catch {
    return {};
  }
}

async function saveUserToml(configPath: string, data: TomlConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const raw = stringifyToml(data);
  await writeFile(configPath, raw, 'utf8');
}

export const register: CommandRegistrar = (
  program: Command,
  io: CliIO,
  setExit: (code: number) => void,
) => {
  const mcpCmd = program.command('mcp').description('Manage Model Context Protocol (MCP) servers');

  mcpCmd
    .command('add <name> [cmdArgs...]')
    .description('Add an MCP server (stdio command after -- or --url)')
    .option('--url <url>', 'HTTP / SSE endpoint URL')
    .allowUnknownOption(true)
    .action(async (name: string, cmdArgs: string[], opts: { url?: string }) => {
      try {
        const dashDashIdx = process.argv.indexOf('--');
        let commandArgs: string[] = [];
        if (dashDashIdx !== -1) {
          commandArgs = process.argv.slice(dashDashIdx + 1);
        } else if (cmdArgs.length > 0) {
          commandArgs = cmdArgs;
        }

        const paths = resolvePaths(io.env);
        const file = userConfigFile(paths);
        const tomlData = await loadUserToml(file);

        tomlData.mcp ??= {};
        tomlData.mcp.servers ??= {};

        if (opts.url) {
          tomlData.mcp.servers[name] = {
            url: opts.url,
            allow_tools: ['*'],
          };
        } else if (commandArgs.length > 0) {
          const firstCmd = commandArgs[0];
          if (!firstCmd) {
            println(io.stderr, 'Error: missing command');
            setExit(EXIT.error);
            return;
          }
          tomlData.mcp.servers[name] = {
            command: firstCmd,
            args: commandArgs.slice(1),
            allow_tools: ['*'],
          };
        } else {
          println(io.stderr, 'Error: specify -- <command...> or --url <url>');
          setExit(EXIT.error);
          return;
        }

        await saveUserToml(file, tomlData);
        println(io.stdout, `Added MCP server "${name}" to ${file}`);
      } catch (err) {
        println(
          io.stderr,
          `Failed to add MCP server: ${err instanceof Error ? err.message : String(err)}`,
        );
        setExit(EXIT.error);
      }
    });

  mcpCmd
    .command('list')
    .description('List configured MCP servers and their status')
    .action(async () => {
      try {
        const cwd = process.cwd();
        const { config } = await loadConfig({ cwd, env: io.env });
        const servers = await resolveMcpServers(cwd, config.mcp);

        const names = Object.keys(servers);
        if (names.length === 0) {
          println(io.stdout, 'No MCP servers configured.');
          return;
        }

        println(io.stdout, 'Configured MCP servers:');
        for (const name of names) {
          const s = servers[name];
          if (!s) continue;
          if (s.command) {
            println(io.stdout, `  • ${name}: stdio -> ${s.command} ${s.args.join(' ')}`);
          } else if (s.url) {
            println(io.stdout, `  • ${name}: url -> ${s.url}`);
          }
        }
      } catch (err) {
        println(
          io.stderr,
          `Failed to list MCP servers: ${err instanceof Error ? err.message : String(err)}`,
        );
        setExit(EXIT.error);
      }
    });

  mcpCmd
    .command('remove <name>')
    .description('Remove an MCP server from user config')
    .action(async (name: string) => {
      try {
        const paths = resolvePaths(io.env);
        const file = userConfigFile(paths);
        const tomlData = await loadUserToml(file);

        if (
          tomlData.mcp?.servers &&
          Object.prototype.hasOwnProperty.call(tomlData.mcp.servers, name)
        ) {
          const updatedServers = { ...tomlData.mcp.servers };
          Reflect.deleteProperty(updatedServers, name);
          tomlData.mcp.servers = updatedServers;
          await saveUserToml(file, tomlData);
          println(io.stdout, `Removed MCP server "${name}"`);
        } else {
          println(io.stderr, `MCP server "${name}" not found in ${file}`);
          setExit(EXIT.error);
        }
      } catch (err) {
        println(
          io.stderr,
          `Failed to remove MCP server: ${err instanceof Error ? err.message : String(err)}`,
        );
        setExit(EXIT.error);
      }
    });

  mcpCmd
    .command('test <name>')
    .description('Test connection to an MCP server and list its tools')
    .action(async (name: string) => {
      try {
        const cwd = process.cwd();
        const { config } = await loadConfig({ cwd, env: io.env });
        const servers = await resolveMcpServers(cwd, config.mcp);
        const target = servers[name];

        if (!target) {
          println(io.stderr, `Unknown MCP server: "${name}"`);
          setExit(EXIT.error);
          return;
        }

        println(io.stdout, `Testing MCP server "${name}"...`);
        const manager = new McpClientManager({ [name]: target });
        try {
          const tools = await manager.listTools();
          println(io.stdout, `Successfully connected. Discovered ${tools.length} tool(s):`);
          for (const t of tools) {
            println(io.stdout, `  - ${t.name}${t.description ? `: ${t.description}` : ''}`);
          }
        } finally {
          await manager.closeAll();
        }
      } catch (err) {
        println(
          io.stderr,
          `Connection test failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setExit(EXIT.error);
      }
    });
};
