import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** An MCP server found in another tool's config, with its raw values (secrets included). */
export interface FoundServer {
  name: string;
  /** Which tool's config it came from. */
  source:
    | 'Claude Code'
    | 'Claude Code (this project)'
    | 'Claude Desktop'
    | 'Cursor'
    | 'Cursor (this project)'
    | 'VS Code'
    | 'VS Code (this project)'
    | 'Windsurf'
    | 'Pasted';
  command?: string;
  args: string[];
  /** Raw values: these can be tokens, so they go to the secrets file, never to config.toml. */
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const record = (v: unknown): Record<string, string> =>
  v && typeof v === 'object'
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      )
    : {};

/** The `mcpServers` map every one of these tools uses, read leniently (extra keys like `type`). */
export function serversFrom(map: unknown, source: FoundServer['source']): FoundServer[] {
  if (!map || typeof map !== 'object') return [];
  const out: FoundServer[] = [];
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const command = typeof s.command === 'string' ? s.command : undefined;
    // Windsurf calls it serverUrl; everyone else url.
    const url =
      typeof s.url === 'string' ? s.url : typeof s.serverUrl === 'string' ? s.serverUrl : undefined;
    if (!command && !url) continue;
    out.push({
      name,
      source,
      ...(command ? { command } : {}),
      args: strings(s.args),
      env: record(s.env),
      ...(url ? { url } : {}),
      headers: record(s.headers),
    });
  }
  return out;
}

/** JSON with the comments and trailing commas VS Code allows in its config files. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return parseJsonc(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Where each tool keeps its MCP servers on this machine. */
export function importPaths(env: NodeJS.ProcessEnv): {
  claudeCode: string;
  claudeDesktop: string;
  cursor: string;
  vscode: string;
  windsurf: string;
} {
  const home = env.HOME ?? homedir();
  const desktop =
    process.platform === 'win32'
      ? join(
          env.APPDATA ?? join(home, 'AppData', 'Roaming'),
          'Claude',
          'claude_desktop_config.json',
        )
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : join(
            env.XDG_CONFIG_HOME ?? join(home, '.config'),
            'Claude',
            'claude_desktop_config.json',
          );
  const vscodeUser =
    process.platform === 'win32'
      ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Code', 'User')
        : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Code', 'User');
  return {
    claudeCode: join(home, '.claude.json'),
    claudeDesktop: desktop,
    cursor: join(home, '.cursor', 'mcp.json'),
    vscode: join(vscodeUser, 'mcp.json'),
    windsurf: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  };
}

type Servers = { mcpServers?: unknown; servers?: unknown } | undefined;

/**
 * Every MCP server set up in Claude Code (user-wide and for `repoRoot`), Claude Desktop, Cursor,
 * VS Code and Windsurf. A name found twice keeps the first: this project's servers (Claude Code,
 * Cursor, VS Code), then the user-wide ones in that same order, then Windsurf.
 */
export async function findOtherToolServers(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Promise<FoundServer[]> {
  const p = importPaths(env);
  const claude = (await readJson(p.claudeCode)) as
    { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } | undefined;
  const project = claude?.projects?.[resolve(repoRoot)]?.mcpServers;
  const desktop = (await readJson(p.claudeDesktop)) as { mcpServers?: unknown } | undefined;
  const cursor = (await readJson(p.cursor)) as Servers;
  const cursorProject = (await readJson(join(repoRoot, '.cursor', 'mcp.json'))) as Servers;
  const vscode = (await readJson(p.vscode)) as Servers;
  const vscodeProject = (await readJson(join(repoRoot, '.vscode', 'mcp.json'))) as Servers;
  const windsurf = (await readJson(p.windsurf)) as Servers;
  const all = [
    ...serversFrom(project, 'Claude Code (this project)'),
    ...serversFrom(cursorProject?.mcpServers, 'Cursor (this project)'),
    ...serversFrom(vscodeProject?.servers, 'VS Code (this project)'),
    ...serversFrom(claude?.mcpServers, 'Claude Code'),
    ...serversFrom(desktop?.mcpServers, 'Claude Desktop'),
    ...serversFrom(cursor?.mcpServers, 'Cursor'),
    ...serversFrom(vscode?.servers, 'VS Code'),
    ...serversFrom(windsurf?.mcpServers, 'Windsurf'),
  ];
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/** A name made from a command line or URL, for a pasted server that came without one. */
export function guessServerName(s: Record<string, unknown>): string {
  const args = strings(s.args).filter((a) => !a.startsWith('-'));
  const basis =
    typeof s.url === 'string'
      ? new URL(s.url).hostname.replace(/^(www|mcp|api)\./, '').split('.')[0]
      : (args[0] ?? (typeof s.command === 'string' ? s.command : 'server'));
  return (
    (basis ?? 'server')
      .replace(/^@[^/]+\//, '')
      .replace(/@[^@]*$/, '')
      .replace(/^(mcp-server-|server-)/, '')
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .toLowerCase() || 'server'
  );
}

/**
 * Servers from pasted JSON: a Claude Desktop / Cursor / Windsurf `{ "mcpServers": {...} }`, a
 * VS Code `{ "servers": {...} }`, a bare `{ "<name>": {...} }` map, or one server object.
 * Throws when it is not JSON or holds no server.
 */
export function parsePastedServers(text: string): FoundServer[] {
  let data: unknown;
  try {
    data = parseJsonc(text.trim());
  } catch {
    throw new Error('That is not valid JSON. Paste the whole object, braces included.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Expected a JSON object such as { "mcpServers": { ... } }');
  const obj = data as Record<string, unknown>;
  const mcp = obj.mcp as { servers?: unknown } | undefined;
  const map =
    obj.mcpServers ??
    obj.servers ??
    mcp?.servers ??
    (typeof obj.command === 'string' ||
    typeof obj.url === 'string' ||
    typeof obj.serverUrl === 'string'
      ? { [guessServerName(obj)]: obj }
      : obj);
  const found = serversFrom(map, 'Pasted');
  if (!found.length)
    throw new Error('No MCP server in that JSON: each one needs a "command" or a "url".');
  return found;
}
