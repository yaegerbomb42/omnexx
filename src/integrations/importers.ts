import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** An MCP server found in another tool's config, with its raw values (secrets included). */
export interface FoundServer {
  name: string;
  /** Which tool's config it came from. */
  source: 'Claude Code' | 'Claude Code (this project)' | 'Claude Desktop' | 'Cursor';
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
    const url = typeof s.url === 'string' ? s.url : undefined;
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

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Where each tool keeps its MCP servers on this machine. */
export function importPaths(env: NodeJS.ProcessEnv): {
  claudeCode: string;
  claudeDesktop: string;
  cursor: string;
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
  return {
    claudeCode: join(home, '.claude.json'),
    claudeDesktop: desktop,
    cursor: join(home, '.cursor', 'mcp.json'),
  };
}

/**
 * Every MCP server set up in Claude Code (user-wide and for `repoRoot`), Claude Desktop and
 * Cursor. A name found twice keeps the first: this project's Claude Code servers, then
 * Claude Code's user-wide ones, then Claude Desktop, then Cursor.
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
  const cursor = (await readJson(p.cursor)) as { mcpServers?: unknown } | undefined;
  const all = [
    ...serversFrom(project, 'Claude Code (this project)'),
    ...serversFrom(claude?.mcpServers, 'Claude Code'),
    ...serversFrom(desktop?.mcpServers, 'Claude Desktop'),
    ...serversFrom(cursor?.mcpServers, 'Cursor'),
  ];
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}
