import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { CommandRegistrar } from './extra/types.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import { confirm, println, readLine, readSecret, type CliIO } from '../io.js';
import { EXIT } from '../exit-codes.js';
import { loadConfig } from '../../config/load.js';
import { findOtherToolServers, parsePastedServers } from '../../integrations/importers.js';
import { findGalleryEntry, GALLERY, type GalleryEntry } from '../../mcp/catalog.js';
import {
  addCommand,
  addFromGallery,
  addUrl,
  importServers,
  listServers,
  loginServer,
  removeServer,
  setAllowTools,
  setEnabled,
  type AddResult,
  type McpPlace,
  type ServerView,
} from '../../mcp/manage.js';
import { tail } from '../../mcp/status.js';
import {
  planInstall,
  searchRegistry,
  type InstallPlan,
  type RegistryHit,
} from '../../integrations/registry.js';
import { installRegistryServer } from '../../integrations/install.js';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
    .option(
      '--set <KEY=VALUE...>',
      'a setting the server needs: env var, header, or gallery value (stored as a secret)',
      [],
    )
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

          const sets = parseSets(opts.set);
          if (opts.url) {
            await report(await addUrl(place(), name, opts.url, sets));
            return;
          }
          if (commandArgs.length > 0 && commandArgs[0]) {
            await report(await addCommand(place(), name, commandArgs, sets));
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
          await installRegistryServer(file, configHome(), plan, values);
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
    .command('gallery [id]')
    .description('Popular MCP servers; with an id, add that one (values with --set KEY=VALUE)')
    .option('--set <KEY=VALUE...>', 'a value the server needs (secrets are stored privately)', [])
    .action(async (id: string | undefined, opts: { set: string[] }) => {
      if (!id) {
        for (const g of GALLERY)
          println(io.stdout, `  ${g.id.padEnd(20)} ${g.name.padEnd(34)} ${galleryHow(g)}`);
        println(io.stdout, '\nAdd one: omnexx mcp gallery <id>');
        return;
      }
      const entry = findGalleryEntry(id);
      if (!entry) {
        println(io.stderr, `"${id}" is not in the gallery. omnexx mcp gallery lists them.`);
        setExit(EXIT.error);
        return;
      }
      try {
        const values = await galleryValues(entry, parseSets(opts.set));
        if (!values) {
          setExit(EXIT.error);
          return;
        }
        await report(await addFromGallery(place(), entry.id, values));
      } catch (err) {
        println(io.stderr, `Failed to add ${entry.name}: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  mcpCmd
    .command('import [names...]')
    .description(
      'Use the MCP servers set up in Claude Code, Claude Desktop, Cursor, VS Code or Windsurf',
    )
    .option('--json <file>', 'import from a JSON file ({"mcpServers": …}); "-" reads stdin')
    .option('-y, --yes', 'import without asking')
    .action(async (names: string[], opts: { yes?: boolean; json?: string }) => {
      try {
        const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
        const have = new Set(Object.keys(config.mcp.servers));
        let found = opts.json
          ? parsePastedServers(await readJsonArg(opts.json))
          : await findOtherToolServers(io.env, io.cwd);
        if (names.length) found = found.filter((s) => names.includes(s.name));
        const fresh = found.filter((s) => !have.has(s.name));
        for (const s of found.filter((x) => have.has(x.name)))
          println(io.stdout, `  = ${s.name} (already set up)`);
        if (!fresh.length) {
          println(
            io.stdout,
            found.length
              ? 'Nothing new to import.'
              : 'No MCP servers found in Claude Code, Claude Desktop, Cursor, VS Code or Windsurf.',
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
        const added = await importServers(place(), fresh);
        println(
          io.stdout,
          `Imported ${added.join(', ')}. Secrets went to the 0600 secrets file, not config.toml.`,
        );
      } catch (err) {
        println(io.stderr, `Import failed: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  async function readJsonArg(src: string): Promise<string> {
    if (src !== '-') return readFile(src, 'utf8');
    let text = '';
    for await (const chunk of io.stdin) text += String(chunk);
    return text;
  }

  mcpCmd
    .command('list')
    .description('MCP servers with their status, tool count and context cost')
    .option('--quick', "don't start the servers, just list the config")
    .action(async (opts: { quick?: boolean }) => {
      try {
        const views = await listServers(place(), { probe: !opts.quick });
        if (views.length === 0) {
          println(
            io.stdout,
            'No MCP servers configured. Add one: omnexx mcp add <name> (popular ones: omnexx mcp gallery), or import: omnexx mcp import',
          );
          return;
        }
        for (const line of formatServers(views)) println(io.stdout, line);
        println(
          io.stdout,
          '\nomnexx mcp enable|disable <name> · allow <name> <glob…> · logs <name> · remove <name>',
        );
      } catch (err) {
        println(io.stderr, `Failed to list MCP servers: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  /** Run a change and print what happened, or the error. */
  async function change(label: string, fn: () => Promise<string>): Promise<void> {
    try {
      println(io.stdout, await fn());
    } catch (err) {
      println(io.stderr, `${label}: ${errText(err)}`);
      setExit(EXIT.error);
    }
  }

  mcpCmd
    .command('enable <name>')
    .description('Start using a disabled MCP server again')
    .action((name: string) =>
      change('Could not enable it', async () => {
        await setEnabled(place(), name, true);
        return `Enabled "${name}"; new chats and runs use it.`;
      }),
    );

  mcpCmd
    .command('disable <name>')
    .description('Stop using an MCP server but keep its setup')
    .action((name: string) =>
      change('Could not disable it', async () => {
        await setEnabled(place(), name, false);
        return `Disabled "${name}"; its tools are gone from new chats and runs.`;
      }),
    );

  mcpCmd
    .command('allow <name> [globs...]')
    .description('Which of its tools the model sees (globs, e.g. "read_*"); none = all')
    .action((name: string, globs: string[]) =>
      change('Could not set the tools', async () => {
        await setAllowTools(place(), name, globs);
        return globs.length
          ? `"${name}" now offers only: ${globs.join(', ')}`
          : `"${name}" offers all its tools.`;
      }),
    );

  mcpCmd
    .command('login <name>')
    .description('Sign in to a remote MCP server in your browser (OAuth)')
    .action((name: string) =>
      change('Sign-in failed', async () => {
        const tools = await signInNow(name);
        return `Signed in to "${name}": ${tools} tool(s).`;
      }),
    );

  mcpCmd
    .command('logs <name>')
    .description("Start an MCP server and show its output (why it won't start)")
    .action(async (name: string) => {
      try {
        const [v] = await listServers(place(), { probe: true, only: name });
        if (!v) throw new Error(`No MCP server called "${name}".`);
        println(io.stdout, `${name}: ${v.state}${v.error ? `\n${v.error}` : ''}`);
        println(io.stdout, v.log ? `--- output ---\n${v.log}` : '(no output)');
      } catch (err) {
        println(io.stderr, errText(err));
        setExit(EXIT.error);
      }
    });

  mcpCmd
    .command('remove <name>')
    .description('Remove an MCP server from user config (and its stored secrets)')
    .action((name: string) =>
      change('Failed to remove MCP server', async () => {
        await removeServer(place(), name);
        return `Removed MCP server "${name}"`;
      }),
    );

  mcpCmd
    .command('test <name>')
    .description('Test connection to an MCP server and list its tools')
    .action(async (name: string) => {
      try {
        println(io.stdout, `Testing MCP server "${name}"...`);
        const [v] = await listServers(place(), { probe: true, only: name });
        if (!v) {
          println(io.stderr, `Unknown MCP server: "${name}"`);
          setExit(EXIT.error);
          return;
        }
        if (v.state !== 'running') {
          println(io.stderr, v.error ?? `"${name}" is ${v.state}`);
          setExit(EXIT.error);
          return;
        }
        println(io.stdout, `Successfully connected. Discovered ${v.tools.length} tool(s):`);
        for (const t of v.tools)
          println(
            io.stdout,
            `  - ${t.name}${t.description ? `: ${t.description}` : ''}${t.allowed ? '' : ' (not allowed)'}`,
          );
      } catch (err) {
        println(io.stderr, `Connection test failed: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  function place(): McpPlace {
    return { cwd: io.cwd, env: io.env };
  }

  function signInNow(name: string): Promise<number> {
    return loginServer(place(), name, {
      ...(io.openUrl ? { open: io.openUrl } : {}),
      log: (l) => {
        println(io.stdout, l);
      },
    });
  }

  /** Say how an add went: tools found, the startup error, or the sign-in it needs. */
  async function report(r: AddResult): Promise<void> {
    println(io.stdout, `Added MCP server "${r.name}" to ${configFile()}`);
    if (r.needsLogin) {
      if (!io.isTTY) {
        println(io.stdout, `It needs you to sign in: omnexx mcp login ${r.name}`);
        return;
      }
      await change('Sign-in failed', async () => `Signed in: ${await signInNow(r.name)} tool(s).`);
      return;
    }
    if (r.probe?.state === 'running') {
      const tools = r.probe.tools.filter((t) => t.allowed);
      const tokens = tools.reduce((s, t) => s + t.tokens, 0);
      println(io.stdout, `It works: ${tools.length} tool(s), ~${tokens} tokens of context.`);
    } else if (r.probe?.error) {
      println(
        io.stderr,
        `${r.probe.error}\nIt is saved; fix it and check with: omnexx mcp test ${r.name}`,
      );
    }
  }

  /** Values a gallery entry asks for: `--set`, else prompted on a terminal. */
  async function galleryValues(
    g: GalleryEntry,
    preset: Record<string, string>,
  ): Promise<Record<string, string> | undefined> {
    if (g.note) println(io.stdout, g.note);
    const values: Record<string, string> = { ...preset };
    for (const need of g.needs) {
      if (values[need.key] || !io.isTTY) continue;
      const prompt = `${need.key}${need.required ? '' : ' (optional, enter to skip)'} — ${need.help}: `;
      const typed = need.secret ? await readSecret(io, prompt) : await readLine(io, prompt);
      values[need.key] = typed ?? '';
    }
    const missing = g.needs.find((n) => n.required && !values[n.key]?.trim());
    if (missing) {
      println(
        io.stderr,
        `${missing.key} is required (${missing.help}). Pass --set ${missing.key}=…`,
      );
      return undefined;
    }
    return values;
  }
};

function galleryHow(g: GalleryEntry): string {
  if (g.oauth) return 'browser sign-in';
  if (g.needs.length) return `needs ${g.needs.map((n) => n.key).join(', ')}`;
  return g.description;
}

const DOT: Record<ServerView['state'], string> = {
  running: '●',
  failed: '✗',
  disabled: '○',
  unchecked: '·',
};

/** One line per server (plus its error), for `mcp list` and the TUI's /mcp. */
export function formatServers(views: readonly ServerView[]): string[] {
  const out: string[] = [];
  for (const v of views) {
    const tools =
      v.state === 'running'
        ? `${v.toolCount} tool${v.toolCount === 1 ? '' : 's'} ~${v.tokens.toLocaleString('en-US')} tok`
        : v.state;
    const scope = v.origin === 'project' ? ' (project)' : '';
    out.push(
      `  ${DOT[v.state]} ${v.name.padEnd(20)} ${tools.padEnd(22)} ${v.kind.padEnd(5)} ${v.target}${scope}`.slice(
        0,
        160,
      ),
    );
    if (v.allowTools.join() !== '*') out.push(`      allows: ${v.allowTools.join(', ')}`);
    if (v.error)
      out.push(
        ...tail(v.error, 6)
          .split('\n')
          .map((l) => `      ${l}`),
      );
  }
  return out;
}
