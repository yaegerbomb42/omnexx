import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import type { CommandRegistrar } from './extra/types.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import { confirm, println, readLine, readSecret, type CliIO } from '../io.js';
import { EXIT } from '../exit-codes.js';
import { McpClientManager } from '../../mcp/client-manager.js';
import { resolveMcpServers } from '../../mcp/config-loader.js';
import { loadConfig } from '../../config/load.js';
import { findOtherToolServers, type FoundServer } from '../../integrations/importers.js';
import {
  planInstall,
  searchRegistry,
  type InstallPlan,
  type RegistryHit,
} from '../../integrations/registry.js';
import { readSecrets, SECRET_PREFIX, writeServerSecrets } from '../../integrations/secrets.js';
import { removeTable, setTable, type TomlValue } from '../../integrations/toml-edit.js';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function readConfigText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** Write one `[mcp.servers.<name>]` table, leaving the rest of the file (and its comments) alone. */
export async function writeServer(
  file: string,
  name: string,
  server: Record<string, TomlValue | undefined>,
): Promise<void> {
  const next = setTable(await readConfigText(file), ['mcp', 'servers', name], server);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next, 'utf8');
}

/** The TOML keys for a server; empty defaults are left out to keep the table short. */
function tomlFor(s: {
  command?: string | undefined;
  args?: readonly string[];
  url?: string | undefined;
  env?: Readonly<Record<string, string>> | readonly string[];
  headers_env?: Readonly<Record<string, string>>;
}): Record<string, TomlValue | undefined> {
  const env = s.env && (Array.isArray(s.env) ? s.env.length : Object.keys(s.env).length);
  const headers = s.headers_env && Object.keys(s.headers_env).length;
  return {
    command: s.command,
    args: s.command && s.args?.length ? s.args : undefined,
    url: s.url,
    env: env ? s.env : undefined,
    headers_env: headers ? s.headers_env : undefined,
  };
}

/** Values for the settings a registry entry asks for: from `--set KEY=VALUE`, else prompted. */
async function collectNeeds(
  io: CliIO,
  plan: InstallPlan,
  preset: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const values: Record<string, string> = {};
  for (const need of plan.needs) {
    let v = preset[need.key];
    if (v === undefined && io.isTTY) {
      const prompt = `${need.key}${need.required ? '' : ' (optional, enter to skip)'}${need.description ? ` — ${need.description}` : ''}: `;
      v = need.secret ? await readSecret(io, prompt) : await readLine(io, prompt);
    }
    v = v?.trim();
    if (!v) {
      if (need.required) {
        println(
          io.stderr,
          `${need.key} is required. Pass it with --set ${need.key}=… (stored in the 0600 secrets file, never in config.toml).`,
        );
        return undefined;
      }
      continue;
    }
    // An Authorization header given as a bare token gets the usual Bearer scheme.
    if (need.target === 'header' && need.key.toLowerCase() === 'authorization' && !/\s/.test(v))
      v = `Bearer ${v}`;
    values[need.key] = v;
  }
  return values;
}

function describeHit(h: RegistryHit, plan: InstallPlan | undefined): string {
  const how = plan ? plan.via : 'no supported way to run it';
  return `${h.trusted ? '✓' : ' '} ${h.name.padEnd(48)} ${how.padEnd(6)} ${(h.title ?? h.description ?? '').replace(/\s+/g, ' ').slice(0, 70)}`;
}

function parseSets(sets: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sets) {
    const at = s.indexOf('=');
    if (at > 0) out[s.slice(0, at)] = s.slice(at + 1);
  }
  return out;
}

export const register: CommandRegistrar = (
  program: Command,
  io: CliIO,
  setExit: (code: number) => void,
) => {
  const mcpCmd = program.command('mcp').description('Manage Model Context Protocol (MCP) servers');
  const search = (q: string) => {
    println(io.stdout, `Searching the MCP registry for "${q}"… (it can take up to a minute)`);
    return searchRegistry(q, {
      fetchFn: io.fetch ?? fetch,
      cacheFile: join(resolvePaths(io.env).configHome, 'cache', 'mcp-registry.json'),
    });
  };
  const configHome = () => resolvePaths(io.env).configHome;
  const configFile = () => userConfigFile(resolvePaths(io.env));

  mcpCmd
    .command('add <name> [cmdArgs...]')
    .description(
      'Add an MCP server: a name from the MCP registry (e.g. playwright), a command after --, or --url',
    )
    .option('--url <url>', 'HTTP endpoint URL')
    .option(
      '--pick <registryName>',
      'which registry entry, e.g. io.github.microsoft/playwright-mcp',
    )
    .option('--set <KEY=VALUE...>', 'a setting the server needs (stored as a secret)', [])
    .option('-y, --yes', 'install without asking')
    .allowUnknownOption(true)
    .action(
      async (
        name: string,
        cmdArgs: string[],
        opts: { url?: string; pick?: string; set: string[]; yes?: boolean },
      ) => {
        try {
          const file = configFile();
          const dashDashIdx = process.argv.indexOf('--');
          const commandArgs = dashDashIdx !== -1 ? process.argv.slice(dashDashIdx + 1) : cmdArgs;

          if (opts.url) {
            await writeServer(file, name, tomlFor({ url: opts.url }));
            println(io.stdout, `Added MCP server "${name}" to ${file}`);
            return;
          }
          if (commandArgs.length > 0 && commandArgs[0]) {
            await writeServer(
              file,
              name,
              tomlFor({ command: commandArgs[0], args: commandArgs.slice(1) }),
            );
            println(io.stdout, `Added MCP server "${name}" to ${file}`);
            return;
          }

          // Just a name: look it up in the MCP registry.
          const hits = await search(opts.pick ?? name);
          const hit = opts.pick ? hits.find((h) => h.name === opts.pick) : hits[0];
          const plan = hit && planInstall(hit);
          if (!hit || !plan) {
            println(
              io.stderr,
              hit
                ? `${hit.name} has no package or endpoint omnexx can run.`
                : `Nothing called "${name}" in the MCP registry. Try: omnexx mcp search ${name}`,
            );
            setExit(EXIT.error);
            return;
          }
          println(io.stdout, hit.title ? `${hit.title}  (${hit.name})` : hit.name);
          println(
            io.stdout,
            `  publisher  ${hit.publisher}${hit.trusted ? '  ✓ known publisher' : '  ⚠ not a known publisher: check it before you trust it'}`,
          );
          if (hit.description) println(io.stdout, `  what       ${hit.description.slice(0, 200)}`);
          println(io.stdout, `  runs       ${plan.runs}`);
          if (plan.needs.length)
            println(
              io.stdout,
              `  needs      ${plan.needs.map((n) => `${n.key}${n.required ? '' : '?'}`).join(', ')}`,
            );
          const others = hits.filter((h) => h !== hit).slice(0, 3);
          if (others.length && !opts.pick)
            println(
              io.stdout,
              `  not it?    omnexx mcp add ${name} --pick <name>; also found: ${others.map((h) => h.name).join(', ')}`,
            );
          if (!opts.yes) {
            if (!io.isTTY) {
              println(io.stdout, '\nRe-run with --yes to install it.');
              return;
            }
            if (!(await confirm(io, `Install as "${plan.name}"?`))) return;
          }
          const values = await collectNeeds(io, plan, parseSets(opts.set));
          if (!values) {
            setExit(EXIT.error);
            return;
          }
          await writeServer(file, plan.name, tomlFor(plan.config));
          await writeServerSecrets(configHome(), plan.name, values);
          println(
            io.stdout,
            `Added MCP server "${plan.name}". Check it with: omnexx mcp test ${plan.name}`,
          );
        } catch (err) {
          println(io.stderr, `Failed to add MCP server: ${errText(err)}`);
          setExit(EXIT.error);
        }
      },
    );

  mcpCmd
    .command('search <query>')
    .description('Search the official MCP registry (✓ = known publisher)')
    .action(async (query: string) => {
      try {
        const hits = await search(query);
        if (!hits.length) {
          println(io.stdout, `Nothing in the MCP registry matches "${query}".`);
          return;
        }
        for (const h of hits.slice(0, 15)) println(io.stdout, describeHit(h, planInstall(h)));
        println(io.stdout, `\nAdd one: omnexx mcp add ${query} --pick <name>`);
      } catch (err) {
        println(io.stderr, `Registry search failed: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  mcpCmd
    .command('import [names...]')
    .description('Use the MCP servers you set up in Claude Code, Claude Desktop or Cursor')
    .option('-y, --yes', 'import without asking')
    .action(async (names: string[], opts: { yes?: boolean }) => {
      try {
        const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
        const have = new Set(Object.keys(config.mcp.servers));
        let found = await findOtherToolServers(io.env, io.cwd);
        if (names.length) found = found.filter((s) => names.includes(s.name));
        const fresh = found.filter((s) => !have.has(s.name));
        for (const s of found.filter((x) => have.has(x.name)))
          println(io.stdout, `  = ${s.name} (already set up)`);
        if (!fresh.length) {
          println(
            io.stdout,
            found.length
              ? 'Nothing new to import.'
              : 'No MCP servers found in Claude Code, Claude Desktop or Cursor.',
          );
          return;
        }
        for (const s of fresh)
          println(
            io.stdout,
            `  + ${s.name.padEnd(24)} ${s.source.padEnd(26)} ${s.command ? `${s.command} ${s.args.join(' ')}` : (s.url ?? '')}`.slice(
              0,
              160,
            ),
          );
        if (!opts.yes) {
          if (!io.isTTY) {
            println(io.stdout, '\nRe-run with --yes to import these.');
            return;
          }
          if (
            !(await confirm(io, `Import ${fresh.length} server${fresh.length === 1 ? '' : 's'}?`))
          )
            return;
        }
        for (const s of fresh) await importServer(s);
        println(
          io.stdout,
          `Imported ${fresh.map((s) => s.name).join(', ')}. Secrets went to the 0600 secrets file, not config.toml.`,
        );
      } catch (err) {
        println(io.stderr, `Import failed: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  /** Env and header values become secret references; the values go to the secrets file. */
  async function importServer(s: FoundServer): Promise<void> {
    const ref = (vals: Record<string, string>, prefix: string) =>
      Object.fromEntries(Object.keys(vals).map((k) => [k, `${SECRET_PREFIX}${prefix}${k}`]));
    await writeServer(
      configFile(),
      s.name,
      tomlFor({
        command: s.command,
        args: s.args,
        url: s.url,
        env: ref(s.env, ''),
        headers_env: ref(s.headers, 'header:'),
      }),
    );
    const secrets = {
      ...s.env,
      ...Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [`header:${k}`, v])),
    };
    if (Object.keys(secrets).length) await writeServerSecrets(configHome(), s.name, secrets);
  }

  mcpCmd
    .command('list')
    .description('List configured MCP servers')
    .action(async () => {
      try {
        const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
        const servers = await resolveMcpServers(io.cwd, config.mcp);
        const names = Object.keys(servers);
        if (names.length === 0) {
          println(
            io.stdout,
            'No MCP servers configured. Add one: omnexx mcp add <name>, or import: omnexx mcp import',
          );
          return;
        }
        println(io.stdout, 'Configured MCP servers:');
        for (const name of names) {
          const s = servers[name];
          if (!s) continue;
          if (s.command)
            println(io.stdout, `  • ${name}: stdio -> ${s.command} ${s.args.join(' ')}`);
          else if (s.url) println(io.stdout, `  • ${name}: url -> ${s.url}`);
        }
      } catch (err) {
        println(io.stderr, `Failed to list MCP servers: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  mcpCmd
    .command('remove <name>')
    .description('Remove an MCP server from user config (and its stored secrets)')
    .action(async (name: string) => {
      try {
        const file = configFile();
        const { text, removed } = removeTable(await readConfigText(file), ['mcp', 'servers', name]);
        if (!removed) {
          println(io.stderr, `MCP server "${name}" not found in ${file}`);
          setExit(EXIT.error);
          return;
        }
        await writeFile(file, text, 'utf8');
        await writeServerSecrets(configHome(), name, {});
        println(io.stdout, `Removed MCP server "${name}"`);
      } catch (err) {
        println(io.stderr, `Failed to remove MCP server: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  mcpCmd
    .command('test <name>')
    .description('Test connection to an MCP server and list its tools')
    .action(async (name: string) => {
      try {
        const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
        const servers = await resolveMcpServers(io.cwd, config.mcp);
        const target = servers[name];
        if (!target) {
          println(io.stderr, `Unknown MCP server: "${name}"`);
          setExit(EXIT.error);
          return;
        }
        println(io.stdout, `Testing MCP server "${name}"...`);
        const manager = new McpClientManager(
          { [name]: target },
          { env: io.env, secrets: await readSecrets(configHome()) },
        );
        try {
          const tools = await manager.listTools();
          println(io.stdout, `Successfully connected. Discovered ${tools.length} tool(s):`);
          for (const t of tools)
            println(io.stdout, `  - ${t.name}${t.description ? `: ${t.description}` : ''}`);
        } finally {
          await manager.closeAll();
        }
      } catch (err) {
        println(io.stderr, `Connection test failed: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });
};
