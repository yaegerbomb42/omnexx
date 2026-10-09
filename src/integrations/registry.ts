import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpServerConfig } from '../config/sections/mcp.js';
import { SECRET_PREFIX } from './secrets.js';

/** The official MCP registry (registry.modelcontextprotocol.io): metadata only, anyone can publish. */
export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

/**
 * Publishers ranked first and marked trusted. The registry ties a name's namespace to a verified
 * GitHub account or domain, so `io.github.microsoft/...` really is Microsoft's; look-alikes
 * (`io.github.someone/github-mcp-server`) are not.
 */
const TRUSTED_NAMESPACES = [
  'io.github.modelcontextprotocol/',
  'io.github.microsoft/',
  'com.microsoft/',
  'io.github.github/',
  'com.github/',
  'io.github.google/',
  'io.github.googleapis/',
  'com.google/',
  'io.github.anthropics/',
  'com.anthropic/',
];

interface Input {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
}

interface Argument {
  type?: string;
  name?: string;
  value?: string;
  isRequired?: boolean;
  variables?: Record<string, unknown>;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transport?: { type?: string };
  environmentVariables?: Input[];
  runtimeArguments?: Argument[];
  packageArguments?: Argument[];
}

export interface RegistryRemote {
  type: string;
  url: string;
  headers?: Input[];
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  packages?: RegistryPackage[] | null;
  remotes?: RegistryRemote[] | null;
}

export interface RegistryHit extends RegistryServer {
  /** The namespace before the slash: who published it. */
  publisher: string;
  trusted: boolean;
}

export const isTrusted = (name: string): boolean =>
  TRUSTED_NAMESPACES.some((n) => name.startsWith(n));

/** The registry can take most of a minute to answer a search. */
const REGISTRY_TIMEOUT_MS = 90_000;
/** Search results are reused for a day. */
const CACHE_MS = 24 * 3_600_000;

interface RegistryBody {
  servers?: {
    server: RegistryServer;
    _meta?: Record<string, { status?: string; isLatest?: boolean } | undefined>;
  }[];
}

/** Read a cached search, if fresh. */
async function cached(
  file: string | undefined,
  url: string,
  now: number,
): Promise<RegistryBody | undefined> {
  if (!file) return undefined;
  try {
    const all = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      { at: number; body: RegistryBody }
    >;
    const hit = all[url];
    return hit && now - hit.at < CACHE_MS ? hit.body : undefined;
  } catch {
    return undefined;
  }
}

async function remember(
  file: string | undefined,
  url: string,
  body: RegistryBody,
  now: number,
): Promise<void> {
  if (!file) return;
  let all: Record<string, { at: number; body: RegistryBody }> = {};
  try {
    all = JSON.parse(await readFile(file, 'utf8')) as typeof all;
  } catch {
    // First search, or an unreadable cache: start over.
  }
  const fresh = Object.fromEntries(Object.entries(all).filter(([, v]) => now - v.at < CACHE_MS));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...fresh, [url]: { at: now, body } }));
}

export interface SearchOptions {
  fetchFn?: typeof fetch;
  limit?: number;
  /** A JSON file to cache searches in for a day (the registry is slow). */
  cacheFile?: string;
  now?: number;
}

/** Latest, active servers matching `query`, trusted publishers first, then closer name matches. */
export async function searchRegistry(
  query: string,
  opts: SearchOptions = {},
): Promise<RegistryHit[]> {
  const { fetchFn = fetch, limit = 50, cacheFile, now = Date.now() } = opts;
  const url = `${REGISTRY_URL}/v0/servers?search=${encodeURIComponent(query)}&version=latest&limit=${limit}`;
  let body = await cached(cacheFile, url, now);
  if (!body) {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`MCP registry answered ${res.status}`);
    body = (await res.json()) as RegistryBody;
    await remember(cacheFile, url, body, now);
  }
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const hits: RegistryHit[] = [];
  for (const { server, _meta } of body.servers ?? []) {
    const official = _meta?.['io.modelcontextprotocol.registry/official'];
    if (official?.status && official.status !== 'active') continue;
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    hits.push({
      ...server,
      publisher: server.name.split('/')[0] ?? server.name,
      trusted: isTrusted(server.name),
    });
  }
  const score = (h: RegistryHit) => {
    const short = (h.name.split('/')[1] ?? h.name).toLowerCase();
    return (
      (h.trusted ? 100 : 0) +
      (short === q ? 20 : short.startsWith(q) ? 10 : short.includes(q) ? 5 : 0)
    );
  };
  return hits.sort((a, b) => score(b) - score(a));
}

/** Something the person must supply at install time. */
export interface InstallNeed {
  key: string;
  description: string;
  secret: boolean;
  required: boolean;
  /** Where the value goes: a server env var, or an HTTP header. */
  target: 'env' | 'header';
}

export interface InstallPlan {
  /** A short config name, e.g. `playwright-mcp`. */
  name: string;
  via: 'npm' | 'pypi' | 'remote' | 'oci';
  config: Omit<McpServerConfig, 'timeout' | 'allow_tools' | 'inherit_env'>;
  needs: InstallNeed[];
  /** One line saying what will run, for the confirmation prompt. */
  runs: string;
}

/** Arguments with a fixed value; ones that need a filled-in variable are left out. */
function fixedArgs(args: readonly Argument[] | undefined): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    if (!a.value || (a.variables && Object.keys(a.variables).length)) continue;
    if (a.type === 'named' && a.name) out.push(a.name, a.value);
    else out.push(a.value);
  }
  return out;
}

const shortName = (name: string) =>
  (name.split('/').pop() ?? name).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase();

/**
 * How to run a registry entry, preferring what needs no extra tooling: an npm package (npx), a
 * PyPI package (uvx), a remote HTTP endpoint, then a container image (docker). Versions are
 * pinned to the ones the entry lists.
 */
export function planInstall(server: RegistryServer): InstallPlan | undefined {
  const name = shortName(server.name);
  const stdio = (server.packages ?? []).filter((p) => (p.transport?.type ?? 'stdio') === 'stdio');
  const order = ['npm', 'pypi'] as const;
  for (const kind of order) {
    const pkg = stdio.find((p) => p.registryType === kind);
    if (!pkg) continue;
    const versioned = pkg.version
      ? kind === 'npm'
        ? `${pkg.identifier}@${pkg.version}`
        : `${pkg.identifier}==${pkg.version}`
      : pkg.identifier;
    const args = [
      ...(kind === 'npm' ? ['-y'] : []),
      ...fixedArgs(pkg.runtimeArguments),
      versioned,
      ...fixedArgs(pkg.packageArguments),
    ];
    const command = kind === 'npm' ? 'npx' : 'uvx';
    const needs = envNeeds(pkg.environmentVariables);
    return {
      name,
      via: kind,
      config: { command, args, env: envRefs(needs), headers_env: {} },
      needs,
      runs: `${command} ${args.join(' ')}`,
    };
  }
  const remote = (server.remotes ?? []).find((r) => r.type === 'streamable-http');
  if (remote) {
    const needs: InstallNeed[] = (remote.headers ?? []).map((h) => ({
      key: h.name,
      description: h.description ?? '',
      secret: h.isSecret ?? false,
      required: h.isRequired ?? h.isSecret ?? false,
      target: 'header',
    }));
    return {
      name,
      via: 'remote',
      config: {
        url: remote.url,
        args: [],
        env: [],
        headers_env: Object.fromEntries(needs.map((n) => [n.key, `${SECRET_PREFIX}${n.key}`])),
      },
      needs,
      runs: `connects to ${remote.url}`,
    };
  }
  const oci = stdio.find((p) => p.registryType === 'oci');
  if (oci) {
    const needs = envNeeds(oci.environmentVariables);
    const args = [
      'run',
      '-i',
      '--rm',
      ...needs.flatMap((n) => ['-e', n.key]),
      ...fixedArgs(oci.runtimeArguments),
      oci.identifier,
      ...fixedArgs(oci.packageArguments),
    ];
    return {
      name,
      via: 'oci',
      config: { command: 'docker', args, env: envRefs(needs), headers_env: {} },
      needs,
      runs: `docker ${args.join(' ')}`,
    };
  }
  return undefined;
}

function envNeeds(vars: readonly Input[] | undefined): InstallNeed[] {
  return (vars ?? []).map((v) => ({
    key: v.name,
    description: v.description ?? '',
    secret: v.isSecret ?? false,
    required: v.isRequired ?? false,
    target: 'env',
  }));
}

/** Every declared env var is read from the stored secrets, filled in at install time. */
function envRefs(needs: readonly InstallNeed[]): Record<string, string> {
  return Object.fromEntries(needs.map((n) => [n.key, `${SECRET_PREFIX}${n.key}`]));
}
