import { writeFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { loadConfig } from '../config/load.js';
import { mcpServerSchema, type McpServerConfig } from '../config/sections/mcp.js';
import { resolvePaths, userConfigFile } from '../core/paths.js';
import type { FoundServer } from '../integrations/importers.js';
import { readConfigText, tomlFor, writeServer } from '../integrations/install.js';
import { readSecrets, SECRET_PREFIX, writeServerSecrets } from '../integrations/secrets.js';
import { removeTable, type TomlValue } from '../integrations/toml-edit.js';
import { McpClientManager } from './client-manager.js';
import { resolveMcpServers } from './config-loader.js';
import { findGalleryEntry, planGalleryInstall } from './catalog.js';
import { signIn } from './login.js';
import { forgetLogin } from './oauth.js';
import type { ProbedTool, ServerProbe, ServerState } from './status.js';

/**
 * Managing MCP servers, shared by `omnexx mcp …`, the TUI's `/mcp` and the VS Code MCP section
 * (through `chat-server`), so all three see and change the same thing. Changes go to the user
 * config.toml, one `[mcp.servers.<name>]` table at a time; secrets go to the 0600 secrets file.
 */

export interface McpPlace {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ServerView {
  name: string;
  /** "user": your config.toml (editable here); "project": omnexx.toml or .mcp.json in the repo. */
  origin: 'user' | 'project';
  kind: 'stdio' | 'http';
  /** The command line, or the URL. */
  target: string;
  enabled: boolean;
  oauth: boolean;
  allowTools: string[];
  state: ServerState;
  /** Every tool the server offers, allowed or not. */
  tools: ProbedTool[];
  /** Tools the model sees, and what their definitions cost per request. */
  toolCount: number;
  tokens: number;
  error?: string;
  log: string;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function checkName(name: string): string {
  const n = name.trim();
  if (!NAME.test(n))
    throw new Error(`"${name}" is not a usable server name: use letters, digits, - and _`);
  return n;
}

const configFile = (place: McpPlace): string => userConfigFile(resolvePaths(place.env));
const configHome = (place: McpPlace): string => resolvePaths(place.env).configHome;

/** Server tables in the user config.toml, as written (before defaults). */
async function userTables(place: McpPlace): Promise<Record<string, Record<string, unknown>>> {
  const text = await readConfigText(configFile(place));
  if (!text.trim()) return {};
  const parsed = parseToml(text) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
  return parsed.mcp?.servers ?? {};
}

export async function configuredServers(place: McpPlace): Promise<Record<string, McpServerConfig>> {
  const { config } = await loadConfig({ cwd: place.cwd, env: place.env });
  return resolveMcpServers(place.cwd, config.mcp);
}

function describe(cfg: McpServerConfig): Pick<ServerView, 'kind' | 'target'> {
  if (cfg.command) return { kind: 'stdio', target: [cfg.command, ...cfg.args].join(' ') };
  return { kind: 'http', target: cfg.url ?? '' };
}

function view(
  name: string,
  cfg: McpServerConfig,
  origin: ServerView['origin'],
  probe: ServerProbe | undefined,
): ServerView {
  const enabled = cfg.enabled !== false;
  const allowed = probe?.tools.filter((t) => t.allowed) ?? [];
  return {
    name,
    origin,
    ...describe(cfg),
    enabled,
    oauth: cfg.oauth === true,
    allowTools: cfg.allow_tools,
    state: !enabled ? 'disabled' : (probe?.state ?? 'unchecked'),
    tools: probe?.tools ?? [],
    toolCount: allowed.length,
    tokens: allowed.reduce((sum, t) => sum + t.tokens, 0),
    ...(probe?.error ? { error: probe.error } : {}),
    log: probe?.log ?? '',
  };
}

/** Start one server, list its tools, and stop it again. */
export async function probeServer(
  place: McpPlace,
  name: string,
  cfg: McpServerConfig,
): Promise<ServerProbe> {
  const home = configHome(place);
  const manager = new McpClientManager(
    { [name]: { ...cfg, enabled: true } },
    { env: place.env, secrets: await readSecrets(home), configHome: home },
  );
  try {
    const [probe] = await manager.probe();
    return probe ?? { name, state: 'failed', tools: [], error: 'not started', log: '' };
  } finally {
    await manager.closeAll();
  }
}

/**
 * Every configured server; with `probe`, each enabled one is started (in parallel) to count its
 * tools and catch startup errors.
 */
export async function listServers(
  place: McpPlace,
  opts: { probe?: boolean; only?: string } = {},
): Promise<ServerView[]> {
  const servers = await configuredServers(place);
  const mine = await userTables(place);
  const names = Object.keys(servers).filter((n) => !opts.only || n === opts.only);
  return Promise.all(
    names.map(async (name) => {
      const cfg = servers[name] as McpServerConfig;
      const probe =
        opts.probe && cfg.enabled !== false ? await probeServer(place, name, cfg) : undefined;
      return view(name, cfg, name in mine ? 'user' : 'project', probe);
    }),
  );
}

/** The server's table in the user config, adopting a project server's config when it has none. */
async function editableTable(
  place: McpPlace,
  name: string,
): Promise<Record<string, TomlValue | undefined>> {
  const mine = (await userTables(place))[name];
  if (mine) return mine as Record<string, TomlValue | undefined>;
  const cfg = (await configuredServers(place))[name];
  if (!cfg) throw new Error(`No MCP server called "${name}". omnexx mcp list shows them.`);
  return {
    ...tomlFor(cfg),
    ...(cfg.allow_tools.join() !== '*' ? { allow_tools: cfg.allow_tools } : {}),
  };
}

async function patchServer(
  place: McpPlace,
  name: string,
  change: Record<string, TomlValue | undefined>,
): Promise<void> {
  const table = { ...(await editableTable(place, name)), ...change };
  await writeServer(configFile(place), name, table);
}

/** Switch a server on or off without forgetting its setup. */
export async function setEnabled(place: McpPlace, name: string, on: boolean): Promise<void> {
  await patchServer(place, name, { enabled: on ? undefined : false });
}

/** Which tools the model may see: globs such as `read_*`; empty or `*` means all. */
export async function setAllowTools(
  place: McpPlace,
  name: string,
  globs: readonly string[],
): Promise<void> {
  const clean = globs.map((g) => g.trim()).filter(Boolean);
  const all = clean.length === 0 || (clean.length === 1 && clean[0] === '*');
  await patchServer(place, name, { allow_tools: all ? undefined : clean });
}

/** Remove a server from the user config, with its secrets and sign-in. */
export async function removeServer(place: McpPlace, name: string): Promise<void> {
  const file = configFile(place);
  const { text, removed } = removeTable(await readConfigText(file), ['mcp', 'servers', name]);
  if (!removed) {
    const elsewhere = (await configuredServers(place))[name];
    throw new Error(
      elsewhere
        ? `"${name}" comes from this project's omnexx.toml or .mcp.json: remove it there, or disable it.`
        : `No MCP server called "${name}".`,
    );
  }
  await writeFile(file, text, 'utf8');
  await writeServerSecrets(configHome(place), name, {});
  await forgetLogin(configHome(place), name);
}

/** Split a command line the way a shell would for simple quoting ("…", '…', backslashes). */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i] ?? '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i] ?? '';
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (quote) throw new Error('The command has an unclosed quote.');
  if (has || cur) out.push(cur);
  return out;
}

/** `KEY=value` env values become secrets; the config only names them. */
async function storeEnv(
  place: McpPlace,
  name: string,
  env: Readonly<Record<string, string>>,
  prefix = '',
): Promise<Record<string, string>> {
  const keys = Object.keys(env).filter((k) => env[k] !== '');
  if (keys.length)
    await writeServerSecrets(
      configHome(place),
      name,
      Object.fromEntries(keys.map((k) => [`${prefix}${k}`, env[k] ?? ''])),
    );
  return Object.fromEntries(keys.map((k) => [k, `${SECRET_PREFIX}${prefix}${k}`]));
}

export interface AddResult {
  name: string;
  /** Running and listing tools, failed, or waiting for a browser sign-in. */
  probe?: ServerProbe;
  needsLogin: boolean;
}

/** Add, then start it once so a broken setup shows its error now rather than mid-run. */
async function check(place: McpPlace, name: string): Promise<AddResult> {
  const cfg = (await configuredServers(place))[name];
  if (!cfg) return { name, needsLogin: false };
  const probe = await probeServer(place, name, cfg);
  const unauthorized =
    probe.state === 'failed' && /sign in|401|unauthori[sz]ed/i.test(probe.error ?? '');
  if (unauthorized && cfg.url && !cfg.oauth) {
    // A remote server that wants a login: switch on OAuth so `login` (or the panel) can sign in.
    await patchServer(place, name, { oauth: true });
  }
  return { name, probe, needsLogin: unauthorized && Boolean(cfg.url) };
}

/** A local server from a command line such as `npx -y @scope/server /some/dir`. */
export async function addCommand(
  place: McpPlace,
  name: string,
  command: string | readonly string[],
  env: Readonly<Record<string, string>> = {},
  opts: { check?: boolean } = {},
): Promise<AddResult> {
  const words = typeof command === 'string' ? splitCommand(command) : [...command];
  const [cmd, ...args] = words;
  if (!cmd) throw new Error('Give the command that starts the server, e.g. npx -y @scope/server');
  const n = checkName(name);
  await writeServer(
    configFile(place),
    n,
    tomlFor({ command: cmd, args, env: await storeEnv(place, n, env) }),
  );
  return opts.check === false ? { name: n, needsLogin: false } : check(place, n);
}

/** A remote server by URL; one that answers 401 is switched to OAuth sign-in. */
export async function addUrl(
  place: McpPlace,
  name: string,
  url: string,
  headers: Readonly<Record<string, string>> = {},
  opts: { check?: boolean } = {},
): Promise<AddResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('The URL must start with http(s)://');
  const n = checkName(name);
  await writeServer(
    configFile(place),
    n,
    tomlFor({ url: parsed.href, headers_env: await storeEnv(place, n, headers, 'header:') }),
  );
  return opts.check === false ? { name: n, needsLogin: false } : check(place, n);
}

/** One of the popular servers, with the values its form asked for. */
export async function addFromGallery(
  place: McpPlace,
  id: string,
  values: Readonly<Record<string, string>>,
  opts: { name?: string; check?: boolean } = {},
): Promise<AddResult> {
  const entry = findGalleryEntry(id);
  if (!entry) throw new Error(`"${id}" is not in the gallery`);
  const n = checkName(opts.name ?? entry.id);
  const { table, secrets } = planGalleryInstall(entry, values);
  await writeServer(configFile(place), n, tomlFor(table));
  await writeServerSecrets(configHome(place), n, secrets);
  if (opts.check === false || entry.oauth) return { name: n, needsLogin: entry.oauth };
  return check(place, n);
}

/** Servers found in another tool's config (or pasted JSON); raw env and header values become secrets. */
export async function importServers(
  place: McpPlace,
  found: readonly FoundServer[],
): Promise<string[]> {
  const added: string[] = [];
  for (const s of found) {
    const name = checkName(s.name);
    await writeServer(
      configFile(place),
      name,
      tomlFor({
        command: s.command,
        args: s.args,
        url: s.url,
        env: await storeEnv(place, name, s.env),
        headers_env: await storeEnv(place, name, s.headers, 'header:'),
      }),
    );
    added.push(name);
  }
  return added;
}

/** Sign in to a remote server in the browser; resolves to its tool count. */
export async function loginServer(
  place: McpPlace,
  name: string,
  deps: { open?: (url: string) => void; log: (line: string) => void },
): Promise<number> {
  const cfg = (await configuredServers(place))[name];
  if (!cfg) throw new Error(`No MCP server called "${name}".`);
  if (!cfg.url) throw new Error(`"${name}" runs locally; there is nothing to sign in to.`);
  if (!cfg.oauth) await patchServer(place, name, { oauth: true });
  const home = configHome(place);
  const secrets = (await readSecrets(home))[name] ?? {};
  const headers = Object.fromEntries(
    Object.entries(cfg.headers_env).flatMap(([h, ref]) => {
      const v = ref.startsWith(SECRET_PREFIX)
        ? secrets[ref.slice(SECRET_PREFIX.length)]
        : (place.env[ref] ?? ref);
      return v === undefined ? [] : [[h, v]];
    }),
  );
  return signIn(name, mcpServerSchema.parse({ ...cfg, oauth: true }), {
    configHome: home,
    headers,
    secrets,
    ...(deps.open ? { open: deps.open } : {}),
    log: deps.log,
  });
}
