import { gunzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { CatalogEntry } from './catalog.js';

export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

export interface RegistryServerRecord {
  id: string;
  kind: 'mcp';
  name: string;
  description: string;
  server: string;
  version?: string | undefined;
  status?: string | undefined;
  source: 'mcp-registry';
  installable: true;
  install?:
    | {
        registryType?: string | undefined;
        identifier?: string | undefined;
        version?: string | undefined;
        remoteType?: string | undefined;
        url?: string | undefined;
      }
    | undefined;
}

export interface RegistrySnapshot {
  source: string;
  fetchedAt: string;
  rawCount: number;
  latestCount: number;
  note?: string;
  servers: RegistryServerRecord[];
  /** Live pagination stopped early on the time budget (partial snapshot). */
  truncated?: boolean;
}

export interface RegistryLoadResult {
  snapshot: RegistrySnapshot;
  from: 'live' | 'cache' | 'bundled';
  entries: Omit<CatalogEntry, 'tokens'>[];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Total budget for one live registry pagination (all pages, not per request).
 * A slow registry must never hold a caller hostage.
 */
export const LIVE_REGISTRY_TIMEOUT_MS = 15_000;

/** Per-request ceiling for a single registry page. */
const PAGE_TIMEOUT_MS = 30_000;

function cachePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OMNEXX_CONFIG_HOME || env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(home, 'omnexx', 'cache', 'mcp-registry-snapshot.json.gz');
}

function bundledCandidates(moduleUrl = import.meta.url): string[] {
  const here = dirname(fileURLToPath(moduleUrl));
  const snap = 'mcp-registry-snapshot.json.gz';
  return [
    // Next to this module (src/runtime/kernel/data or dist/.../data after copy)
    join(here, 'data', snap),
    join(here, '..', 'data', snap),
    join(here, '..', '..', 'data', snap),
    join(here, '..', '..', '..', 'data', snap),
    // Dev / package layouts
    join(here, '..', '..', '..', 'src', 'runtime', 'kernel', 'data', snap),
    join(process.cwd(), 'src', 'runtime', 'kernel', 'data', snap),
    join(process.cwd(), 'dist', 'data', snap),
    join(process.cwd(), 'data', snap),
  ];
}

async function readGzipJson(path: string): Promise<RegistrySnapshot> {
  const buf = await readFile(path);
  const json = gunzipSync(buf).toString('utf8');
  return JSON.parse(json) as RegistrySnapshot;
}

async function writeGzipJson(path: string, snap: RegistrySnapshot): Promise<void> {
  const { gzipSync } = await import('node:zlib');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, gzipSync(Buffer.from(JSON.stringify(snap))));
}

/** Paginate the live official MCP Registry; keep latest per server name. */
export async function fetchLiveRegistry(
  opts: {
    limit?: number;
    fetchImpl?: typeof fetch;
    maxPages?: number;
    /** Total budget for the whole pagination (ms). 0 = unbounded (per-page limit only). */
    timeoutMs?: number;
  } = {},
): Promise<RegistrySnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pageSize = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 250;
  const budget = opts.timeoutMs ?? LIVE_REGISTRY_TIMEOUT_MS;
  const deadline = budget > 0 ? Date.now() + budget : undefined;
  let cursor: string | undefined;
  let truncated = false;
  const raw: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const remaining = deadline === undefined ? PAGE_TIMEOUT_MS : deadline - Date.now();
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const url = new URL(MCP_REGISTRY_URL);
    url.searchParams.set('limit', String(pageSize));
    if (cursor) url.searchParams.set('cursor', cursor);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'omnexx-kernel/1.0' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(PAGE_TIMEOUT_MS, remaining))),
      });
    } catch (err) {
      // Ran out of budget mid-request: keep the pages we already have.
      if (deadline !== undefined && Date.now() >= deadline) {
        truncated = true;
        break;
      }
      throw err;
    }
    if (!res.ok) throw new Error(`MCP registry HTTP ${res.status}`);
    const body = (await res.json()) as {
      servers?: unknown[];
      metadata?: { nextCursor?: string };
    };
    const rows = body.servers ?? [];
    raw.push(...rows);
    cursor = body.metadata?.nextCursor;
    if (!cursor || rows.length === 0) break;
  }

  const latest = new Map<string, RegistryServerRecord>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as {
      server?: Record<string, unknown>;
      _meta?: Record<string, Record<string, unknown>>;
    };
    const srv = r.server;
    if (!srv || typeof srv.name !== 'string') continue;
    const name = srv.name;
    const meta = r._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
    const packages = Array.isArray(srv.packages) ? srv.packages : [];
    const remotes = Array.isArray(srv.remotes) ? srv.remotes : [];
    let install: RegistryServerRecord['install'];
    if (packages[0] && typeof packages[0] === 'object') {
      const p0 = packages[0] as Record<string, unknown>;
      install = {
        registryType: typeof p0.registryType === 'string' ? p0.registryType : undefined,
        identifier:
          typeof p0.identifier === 'string'
            ? p0.identifier
            : typeof p0.name === 'string'
              ? p0.name
              : undefined,
        version: typeof p0.version === 'string' ? p0.version : undefined,
      };
    } else if (remotes[0] && typeof remotes[0] === 'object') {
      const r0 = remotes[0] as Record<string, unknown>;
      install = {
        remoteType: typeof r0.type === 'string' ? r0.type : undefined,
        url: typeof r0.url === 'string' ? r0.url : undefined,
      };
    }
    const rec: RegistryServerRecord = {
      id: `registry:mcp:${name}`,
      kind: 'mcp',
      name: typeof srv.title === 'string' ? srv.title : name.split('/').pop() || name,
      description: typeof srv.description === 'string' ? srv.description.slice(0, 500) : '',
      server: name,
      version: typeof srv.version === 'string' ? srv.version : undefined,
      status: typeof meta.status === 'string' ? meta.status : 'active',
      source: 'mcp-registry',
      installable: true,
      ...(install ? { install } : {}),
    };
    const prev = latest.get(name);
    if (!prev || meta.isLatest === true) latest.set(name, rec);
  }

  const servers = [...latest.values()]
    .filter((s) => s.status === 'active')
    .sort((a, b) => a.server.localeCompare(b.server));

  return {
    source: MCP_REGISTRY_URL,
    fetchedAt: new Date().toISOString(),
    rawCount: raw.length,
    latestCount: servers.length,
    note: 'Live fetch from official MCP Registry (latest per server name).',
    servers,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Union live refresh with a floor snapshot so a bounded fetch never shrinks the catalog. */
export function mergeWithFloor(live: RegistrySnapshot, floor: RegistrySnapshot): RegistrySnapshot {
  const map = new Map<string, RegistryServerRecord>();
  for (const s of floor.servers) map.set(s.server, s);
  for (const s of live.servers) map.set(s.server, s); // live wins on conflict
  const servers = [...map.values()].sort((a, b) => a.server.localeCompare(b.server));
  const shrunk = live.latestCount < floor.latestCount;
  return {
    source: live.source,
    fetchedAt: live.fetchedAt,
    rawCount: Math.max(live.rawCount, floor.rawCount),
    latestCount: servers.length,
    note: shrunk
      ? `Live refresh (${live.latestCount}) merged with bundled/cache floor (${floor.latestCount}) so the catalog never shrinks.`
      : (live.note ?? 'Live fetch from official MCP Registry (latest per server name).'),
    servers,
  };
}

async function readBundledSnapshot(moduleUrl: string): Promise<RegistrySnapshot | undefined> {
  for (const path of bundledCandidates(moduleUrl)) {
    try {
      const snap = await readGzipJson(path);
      if (snap.servers?.length) return snap;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Load registry: prefer fresh cache, else live refresh, else bundled snapshot. */
export async function loadRegistry(opts?: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Skip live network (tests / offline). */
  offline?: boolean;
  moduleUrl?: string;
  /** Total budget for the live pagination (ms). 0 = unbounded. */
  timeoutMs?: number;
}): Promise<RegistryLoadResult> {
  const env = opts?.env ?? process.env;
  const cache = cachePath(env);

  // 1. Fresh local cache
  try {
    const snap = await readGzipJson(cache);
    const age = Date.now() - Date.parse(snap.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS && snap.servers?.length) {
      return { snapshot: snap, from: 'cache', entries: toCatalogEntries(snap) };
    }
  } catch {
    // miss
  }

  // 2. Live refresh (unless offline) — never shrink below bundled/cache floor (#19).
  if (!opts?.offline) {
    try {
      let snap = await fetchLiveRegistry({
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        maxPages: 80, // bounded refresh; floor merge restores the rest
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      const truncated = snap.truncated === true;
      const bundled = await readBundledSnapshot(opts?.moduleUrl ?? import.meta.url);
      let cachedFloor: RegistrySnapshot | undefined;
      try {
        const cached = await readGzipJson(cache);
        if (cached.servers?.length) cachedFloor = cached;
      } catch {
        // no cache
      }
      const floorCandidates = [bundled, cachedFloor].filter((s): s is RegistrySnapshot =>
        Boolean(s?.servers?.length),
      );
      if (floorCandidates.length) {
        const floor = floorCandidates.reduce((a, b) => (a.latestCount >= b.latestCount ? a : b));
        snap = mergeWithFloor(snap, floor);
      }
      // A truncated refresh is not a full snapshot: don't pin it as the fresh cache.
      if (!truncated) await writeGzipJson(cache, snap).catch(() => undefined);
      return { snapshot: snap, from: 'live', entries: toCatalogEntries(snap) };
    } catch {
      // fall through
    }
  }

  // 3. Stale cache still better than nothing
  try {
    const snap = await readGzipJson(cache);
    if (snap.servers?.length)
      return { snapshot: snap, from: 'cache', entries: toCatalogEntries(snap) };
  } catch {
    // miss
  }

  // 4. Bundled snapshot shipped with Omnexx
  for (const path of bundledCandidates(opts?.moduleUrl ?? import.meta.url)) {
    try {
      const snap = await readGzipJson(path);
      if (snap.servers?.length)
        return { snapshot: snap, from: 'bundled', entries: toCatalogEntries(snap) };
    } catch {
      // try next
    }
  }

  return {
    snapshot: {
      source: MCP_REGISTRY_URL,
      fetchedAt: new Date(0).toISOString(),
      rawCount: 0,
      latestCount: 0,
      servers: [],
      note: 'No registry data available',
    },
    from: 'bundled',
    entries: [],
  };
}

export function toCatalogEntries(snap: RegistrySnapshot): Omit<CatalogEntry, 'tokens'>[] {
  return snap.servers.map((s) => ({
    id: s.id,
    kind: 'mcp' as const,
    name: s.name,
    description: s.description,
    server: s.server,
    // No inputSchema until the server is installed + mounted (lazy).
  }));
}

/** Human-readable install suggestion — never executes untrusted code. */
export function installSuggestion(rec: RegistryServerRecord): string {
  const lines = [
    `Capability "${rec.id}" is in the official MCP Registry but is NOT installed locally.`,
    `Server: ${rec.server}${rec.version ? `@${rec.version}` : ''}`,
    rec.description ? `About: ${rec.description}` : '',
    'Omnexx will not download or run it automatically.',
    'To enable it, add it to your Omnexx MCP config (or run `omnexx mcp add` / the VS Code MCP gallery), then remount.',
  ];
  if (rec.install?.identifier) {
    lines.push(
      `Registry package hint: ${rec.install.registryType ?? 'package'} ${rec.install.identifier}` +
        (rec.install.version ? `@${rec.install.version}` : ''),
    );
  }
  if (rec.install?.url) {
    lines.push(`Remote MCP URL hint: ${rec.install.url} (${rec.install.remoteType ?? 'remote'})`);
  }
  return lines.filter(Boolean).join('\n');
}
