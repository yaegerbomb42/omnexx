import { readFile, readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { CatalogEntry } from './catalog.js';
import { parseFrontmatter } from '../../instructions/frontmatter.js';
import { skillDirs, type SkillRoots } from '../../instructions/skills.js';

export interface DiscoveredLocal {
  entries: Omit<CatalogEntry, 'tokens'>[];
  sources: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Extract MCP server name→config maps from common client config shapes. */
function serversFromMcpJson(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  if (o.mcpServers && typeof o.mcpServers === 'object')
    return o.mcpServers as Record<string, unknown>;
  if (o.servers && typeof o.servers === 'object') return o.servers as Record<string, unknown>;
  return {};
}

/**
 * Discover locally installed/configured MCP servers from Omnexx config and
 * common client config files (Claude Desktop, Cursor, VS Code, project .mcp.json).
 * Tool schemas are NOT fetched here — only headers; live tools load lazily on mount.
 */
export async function discoverLocalMcpServers(opts: {
  repoRoot?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Parsed Omnexx `[mcp].servers` table when already loaded. */
  omnexxServers?: Record<string, unknown> | undefined;
}): Promise<DiscoveredLocal> {
  const env = opts.env ?? process.env;
  const home = env.HOME ?? homedir();
  const entries: Omit<CatalogEntry, 'tokens'>[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();

  const add = (name: string, description: string, source: string) => {
    const id = `local:mcp:${name}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({
      id,
      kind: 'mcp',
      name,
      description: description || `Locally configured MCP server "${name}" (${source})`,
      server: name,
    });
    if (!sources.includes(source)) sources.push(source);
  };

  for (const [name, cfg] of Object.entries(opts.omnexxServers ?? {})) {
    const desc =
      cfg &&
      typeof cfg === 'object' &&
      typeof (cfg as { description?: unknown }).description === 'string'
        ? (cfg as { description: string }).description
        : `Omnexx-configured MCP server`;
    add(name, desc, 'omnexx-config');
  }

  const candidates: { path: string; source: string }[] = [];
  if (opts.repoRoot) {
    candidates.push({ path: join(opts.repoRoot, '.mcp.json'), source: 'project:.mcp.json' });
    candidates.push({
      path: join(opts.repoRoot, '.vscode', 'mcp.json'),
      source: 'project:.vscode/mcp.json',
    });
    candidates.push({
      path: join(opts.repoRoot, '.cursor', 'mcp.json'),
      source: 'project:.cursor/mcp.json',
    });
  }
  candidates.push(
    {
      path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      source: 'claude-desktop',
    },
    {
      path: join(home, '.config', 'Claude', 'claude_desktop_config.json'),
      source: 'claude-desktop-linux',
    },
    { path: join(home, '.cursor', 'mcp.json'), source: 'cursor-user' },
    {
      path: join(
        home,
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'mcp.json',
      ),
      source: 'cursor-globalStorage',
    },
    { path: join(home, '.vscode', 'mcp.json'), source: 'vscode-user' },
  );

  for (const c of candidates) {
    if (!(await exists(c.path))) continue;
    const raw = await readJsonIfExists(c.path);
    const servers = serversFromMcpJson(raw);
    for (const name of Object.keys(servers)) add(name, `Configured in ${c.source}`, c.source);
  }

  // Omnexx user config.toml [mcp.servers]
  const configHome = env.OMNEXX_CONFIG_HOME || env.XDG_CONFIG_HOME || join(home, '.config');
  const userToml = join(configHome, 'omnexx', 'config.toml');
  if (await exists(userToml)) {
    try {
      const parsed = parseToml(await readFile(userToml, 'utf8')) as {
        mcp?: { servers?: Record<string, unknown> };
      };
      for (const name of Object.keys(parsed.mcp?.servers ?? {})) {
        add(name, 'Omnexx user config.toml', 'omnexx-user-toml');
      }
    } catch {
      // ignore malformed
    }
  }

  return { entries, sources };
}

/**
 * Discover real skills: Omnexx skill dirs + Claude/Cursor-style SKILL.md trees
 * (~/.claude/skills, .cursor/skills, project skills via skillDirs).
 * Optional remote enrichment uses the real SkillMD public API (skillmd.com) —
 * verified to exist; never invent a fake index.
 */
export async function discoverLocalSkills(opts: {
  repoRoot?: string | undefined;
  env?: NodeJS.ProcessEnv;
  dirs?: readonly string[] | undefined;
}): Promise<DiscoveredLocal> {
  const env = opts.env ?? process.env;
  const home = env.HOME ?? homedir();
  const roots: SkillRoots = {
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
    env,
    importClaude: true,
    ...(opts.dirs ? { dirs: opts.dirs } : {}),
  };

  // Extra Cursor skill roots (not in Omnexx's default skillDirs).
  const extraDirs = [
    join(home, '.cursor', 'skills'),
    ...(opts.repoRoot ? [join(opts.repoRoot, '.cursor', 'skills')] : []),
  ];

  const entries: Omit<CatalogEntry, 'tokens'>[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();

  const allDirs = [
    ...skillDirs(roots).map((d) => ({ dir: d.dir, source: d.source })),
    ...extraDirs.map((dir) => ({ dir, source: 'cursor-skills' as const })),
  ];

  for (const { dir, source } of allDirs) {
    const listing = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of listing) {
      if (!ent.isDirectory()) continue;
      const skillMd = join(dir, ent.name, 'SKILL.md');
      if (!(await exists(skillMd))) continue;
      try {
        const text = await readFile(skillMd, 'utf8');
        const { data, body } = parseFrontmatter(text);
        const name =
          typeof data.name === 'string' && data.name.trim() ? data.name.trim() : ent.name;
        const description =
          typeof data.description === 'string' && data.description.trim()
            ? data.description.trim()
            : body
                .split('\n')
                .find((l) => l.trim())
                ?.trim() || `Skill ${name}`;
        const id = `local:skill:${name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push({
          id,
          kind: 'skill',
          name,
          description: description.slice(0, 500),
          triggerConditions:
            typeof data['trigger-conditions'] === 'string'
              ? data['trigger-conditions']
              : typeof data.triggerConditions === 'string'
                ? data.triggerConditions
                : undefined,
        });
        if (!sources.includes(String(source))) sources.push(String(source));
      } catch {
        // skip unreadable skill
      }
    }
  }

  return { entries, sources };
}

/** Expand a ~ path. */
export function expandHome(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return isAbsolute(p) ? p : p;
}

/** SkillMD public search API — real registry at api.skillmd.com (verified). */
export const SKILLMD_SEARCH_URL = 'https://api.skillmd.com/v1/search';

export interface SkillMdHit {
  slug: string;
  title: string;
  description: string;
  verified?: boolean;
  raw_url?: string;
}

/**
 * Search the public SkillMD skills index. Returns catalog headers only;
 * mounting still requires a local install (suggestInstall, never auto-run).
 */
export async function searchSkillMd(
  query: string,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<Omit<CatalogEntry, 'tokens'>[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 8;
  const url = new URL(SKILLMD_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'omnexx-kernel/1.0' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: SkillMdHit[] };
    const items = body.items ?? [];
    return items.slice(0, limit).map((it) => ({
      id: `registry:skill:${it.slug}`,
      kind: 'skill' as const,
      name: it.title || it.slug,
      description:
        (it.description || `SkillMD skill ${it.slug}`).slice(0, 500) +
        (it.verified ? ' [SkillMD verified]' : '') +
        ' (SkillMD — install locally before mount)',
      server: 'skillmd',
    }));
  } catch {
    return [];
  }
}

/**
 * Memoize a remote search by normalized query (TTL) and share in-flight requests, so a
 * model retry storm on `search_capabilities` cannot amplify traffic to a public index.
 */
export function cachedSearch<T>(
  fn: (query: string, limit: number) => Promise<T[]>,
  opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): (query: string, limit: number) => Promise<T[]> {
  const ttl = opts.ttlMs ?? 10 * 60 * 1000;
  const maxEntries = opts.maxEntries ?? 200;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<T[]> }>();
  return (query, limit) => {
    const key = `${limit}:${query.trim().toLowerCase().replace(/\s+/g, ' ')}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = fn(query, limit).catch((err: unknown) => {
      cache.delete(key); // don't pin failures
      throw err;
    });
    cache.set(key, { at: now(), value });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return value;
  };
}
