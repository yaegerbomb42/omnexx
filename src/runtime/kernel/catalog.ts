import { z } from 'zod';
import { ok, fail, type Tool } from '../../tools/types.js';
import type { CapabilityEntry } from './types.js';
import { CapabilityRetriever, type RetrievalDoc } from './retrieval.js';

/** How long unverified remote (SkillMD) search hits stay in the catalog. */
export const REMOTE_SKILL_TTL_MS = 30 * 60 * 1000;

export interface CatalogEntry {
  /** Stable id, e.g. `mcp:github:create_issue` or `skill:testing`. */
  id: string;
  kind: 'tool' | 'skill' | 'mcp';
  name: string;
  description: string;
  /** Optional MCP server name (lazy connect key). */
  server?: string | undefined;
  triggerConditions?: string | undefined;
  /** Full JSON schema — only attached while mounted. */
  inputSchema?: Record<string, unknown> | undefined;
  /** Pre-tokenized text for TF-IDF. */
  tokens: string[];
  embedding?: number[] | undefined;
}

export interface CatalogSearchOptions {
  /** Low-weight context terms (recent tool errors, state delta). */
  context?: string | undefined;
  /** Additive per-id prior (co-usage, stickiness). */
  bonus?: ((id: string) => number) | undefined;
}

export interface CatalogSelectOptions {
  query: string;
  /** Max capabilities to keep mounted (default 8). */
  maxMounted?: number | undefined;
  /** Always keep these ids mounted. */
  pin?: readonly string[] | undefined;
}

export interface CatalogSelectResult {
  mounted: CatalogEntry[];
  added: string[];
  removed: string[];
  /** Wall time of the select call in ms. */
  ms: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_+/.-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Scalable capability registry: holds thousands of MCP tool / skill *headers*
 * without putting their schemas in the model context. Selection is System-1
 * (TF-IDF / embeddings + rules) and finishes in well under 50ms on 2k entries.
 */
export class CapabilityCatalog {
  private entries = new Map<string, CatalogEntry>();
  /** Expiry (epoch ms) for ephemeral entries such as unverified remote SkillMD hits. */
  private expiry = new Map<string, number>();
  private readonly retriever = new CapabilityRetriever();
  private retrieverDirty = true;
  private isInstalled: (id: string) => boolean = (id) => id.startsWith('local:');
  private mounted = new Map<string, CatalogEntry>();
  private lru: string[] = [];
  private turnsSinceSelect = 0;
  private lastQuery = '';

  get size(): number {
    return this.entries.size;
  }

  get mountedCount(): number {
    return this.mounted.size;
  }

  getMounted(): readonly CatalogEntry[] {
    return [...this.mounted.values()];
  }

  getMountedIds(): readonly string[] {
    return [...this.mounted.keys()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  isMounted(id: string): boolean {
    return this.mounted.has(id);
  }

  /** All entries (headers only), insertion order. */
  allEntries(): readonly CatalogEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  /** Replace the catalog contents (headers only). O(n) rebuild of IDF. */
  load(entries: readonly Omit<CatalogEntry, 'tokens'>[]): void {
    this.entries.clear();
    this.expiry.clear();
    for (const e of entries) {
      const text = `${e.name} ${e.description} ${e.triggerConditions ?? ''} ${e.server ?? ''}`;
      this.entries.set(e.id, { ...e, tokens: tokenize(text) });
    }
    this.rebuildIdf();
    // Drop mounts that no longer exist.
    for (const id of [...this.mounted.keys()]) {
      if (!this.entries.has(id)) {
        this.mounted.delete(id);
        this.lru = this.lru.filter((x) => x !== id);
      }
    }
  }

  /** Merge additional entries without clearing (for incremental MCP discovery). */
  upsert(
    entries: readonly Omit<CatalogEntry, 'tokens'>[],
    opts: { ttlMs?: number; now?: number } = {},
  ): void {
    const now = opts.now ?? Date.now();
    for (const e of entries) {
      const text = `${e.name} ${e.description} ${e.triggerConditions ?? ''} ${e.server ?? ''}`;
      const existed = this.entries.has(e.id);
      this.entries.set(e.id, { ...e, tokens: tokenize(text) });
      if (opts.ttlMs !== undefined) {
        // Never demote a permanent entry to ephemeral.
        if (!existed || this.expiry.has(e.id)) this.expiry.set(e.id, now + opts.ttlMs);
      } else {
        this.expiry.delete(e.id);
      }
    }
    this.rebuildIdf();
  }

  /** Evict expired ephemeral entries (mounted ones are kept until unmounted). */
  pruneExpired(now = Date.now()): number {
    let removed = 0;
    for (const [id, at] of this.expiry) {
      if (at > now || this.mounted.has(id)) continue;
      this.expiry.delete(id);
      this.entries.delete(id);
      removed++;
    }
    if (removed) this.rebuildIdf();
    return removed;
  }

  /** Convert to CapabilityEntry shape used by the meta-router. */
  asCapabilityEntries(): CapabilityEntry[] {
    return [...this.entries.values()].map((e) => ({
      kind: e.kind === 'skill' ? 'skill' : 'tool',
      id: e.id,
      name: e.name,
      description: e.description,
      tokens: e.tokens,
      ...(e.triggerConditions !== undefined ? { triggerConditions: e.triggerConditions } : {}),
      ...(e.embedding ? { embedding: e.embedding } : {}),
    }));
  }

  /**
   * Rank the whole catalog for `query` (TF-IDF; uses embeddings when present).
   * Returns top-K ids — does not change the mount set.
   */
  search(query: string, k = 10, opts: CatalogSearchOptions = {}): CatalogEntry[] {
    this.pruneExpired();
    if (!query.trim()) return [...this.entries.values()].slice(0, k);
    return this.rankEntries(query, k, opts).map((r) => r.entry);
  }

  /** Ranked search with scores (field-weighted BM25 + expansion + installed-first priors). */
  rankEntries(
    query: string,
    k = 10,
    opts: CatalogSearchOptions = {},
  ): { entry: CatalogEntry; score: number }[] {
    if (this.retrieverDirty) {
      this.retriever.build([...this.entries.values()]);
      this.retrieverDirty = false;
    }
    const isInstalled = this.isInstalled;
    return this.retriever
      .rank(query, k, {
        isInstalled: (d) => isInstalled(d.id),
        ...(opts.context ? { context: opts.context } : {}),
        ...(opts.bonus ? { bonus: (d: RetrievalDoc) => opts.bonus?.(d.id) ?? 0 } : {}),
      })
      .flatMap((r) => {
        const entry = this.entries.get(r.doc.id);
        return entry ? [{ entry, score: r.score }] : [];
      });
  }

  /** Decide which ids count as installed for installed-first ranking (default: `local:*`). */
  setInstalledPredicate(fn: (id: string) => boolean): void {
    this.isInstalled = fn;
  }

  /**
   * Hot-swap the mount set: rank by query, pin required ids, LRU-evict the rest.
   * Fast enough to call every few turns on catalogs of thousands.
   */
  select(opts: CatalogSelectOptions): CatalogSelectResult {
    const t0 = Date.now();
    const maxMounted = opts.maxMounted ?? 8;
    const ranked = this.search(opts.query, Math.max(maxMounted * 3, 24));
    const nextIds: string[] = [];
    for (const id of opts.pin ?? []) {
      if (this.entries.has(id) && !nextIds.includes(id)) nextIds.push(id);
    }
    for (const e of ranked) {
      if (nextIds.length >= maxMounted) break;
      if (!nextIds.includes(e.id)) nextIds.push(e.id);
    }

    const prev = new Set(this.mounted.keys());
    const next = new Set(nextIds);
    const added: string[] = [];
    const removed: string[] = [];

    for (const id of prev) {
      if (!next.has(id)) {
        this.mounted.delete(id);
        removed.push(id);
      }
    }
    for (const id of nextIds) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (!prev.has(id)) added.push(id);
      this.mounted.set(id, e);
      this.touchLru(id);
    }
    // Enforce cap via LRU (pins first).
    const pinned = new Set(opts.pin ?? []);
    while (this.mounted.size > maxMounted) {
      const victim = this.lru.find((id) => !pinned.has(id) && this.mounted.has(id));
      if (!victim) break;
      this.mounted.delete(victim);
      this.lru = this.lru.filter((x) => x !== victim);
      if (!removed.includes(victim)) removed.push(victim);
    }

    this.turnsSinceSelect = 0;
    this.lastQuery = opts.query;
    return { mounted: this.getMounted().slice(), added, removed, ms: Date.now() - t0 };
  }

  /** Explicitly mount one capability (from search_capabilities). Evicts LRU if over cap. */
  mount(id: string, maxMounted = 8): CatalogEntry | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    this.mounted.set(id, e);
    this.touchLru(id);
    while (this.mounted.size > maxMounted) {
      const victim = this.lru.find((x) => x !== id && this.mounted.has(x));
      if (!victim) break;
      this.mounted.delete(victim);
      this.lru = this.lru.filter((x) => x !== victim);
    }
    return e;
  }

  unmount(id: string): boolean {
    const ok = this.mounted.delete(id);
    this.lru = this.lru.filter((x) => x !== id);
    return ok;
  }

  /** Call once per agent turn; returns true when a re-select is due. */
  shouldReselect(args: {
    everyNTurns: number;
    frictionScore: number;
    newTask: boolean;
    force?: boolean | undefined;
  }): boolean {
    this.turnsSinceSelect += 1;
    if (args.force || args.newTask) return true;
    if (args.frictionScore >= 2) return true;
    if (args.everyNTurns > 0 && this.turnsSinceSelect >= args.everyNTurns) return true;
    return false;
  }

  lastSelectQuery(): string {
    return this.lastQuery;
  }

  private touchLru(id: string): void {
    this.lru = this.lru.filter((x) => x !== id);
    this.lru.push(id);
  }

  private rebuildIdf(): void {
    // Index rebuild is lazy (next search) so bursts of upserts stay cheap on 50k+ catalogs.
    this.retrieverDirty = true;
  }
}

const searchSchema = z.strictObject({
  query: z
    .string()
    .describe('What capability you need (e.g. "create github issue", "run browser test")'),
  limit: z.number().int().min(1).max(25).default(8),
});

const mountSchema = z.strictObject({
  id: z.string().describe('Capability id from search_capabilities results'),
});

export interface CatalogToolsOptions {
  maxMounted?: number;
  /**
   * Called when the model tries to mount a registry:* id that is not installed locally.
   * Must return an install suggestion string — never install/run anything.
   */
  suggestInstall?: (id: string, entry: CatalogEntry) => string | undefined;
  /** Ids that are considered locally installed (local:mcp:* always; registry:* only if mirrored). */
  isInstalled?: (id: string, entry: CatalogEntry) => boolean;
  /**
   * Optional live public skills search (SkillMD). Results are merged into search_capabilities
   * and upserted into the catalog as installable-but-not-installed headers.
   */
  publicSkillSearch?: (
    query: string,
    limit: number,
  ) => Promise<readonly Omit<CatalogEntry, 'tokens'>[]>;
  /** After a successful catalog mount — lazy-connect MCP / page skill body. */
  onMount?: (entry: CatalogEntry) => Promise<string | undefined>;
  /** After a capability leaves the mount set (explicit unmount or LRU eviction). */
  onUnmount?: (id: string) => Promise<void>;
}

/**
 * Meta-tools so the model can discover and pull in capabilities that are not
 * currently mounted — the escape hatch for a catalog of thousands.
 */
export function createCatalogTools(
  catalog: CapabilityCatalog,
  opts: CatalogToolsOptions | number = 8,
): Tool[] {
  const options: CatalogToolsOptions = typeof opts === 'number' ? { maxMounted: opts } : opts;
  const maxMounted = options.maxMounted ?? 8;

  const searchTool: Tool<typeof searchSchema> = {
    name: 'search_capabilities',
    description:
      'Search the Omnexx capability catalog (official MCP Registry + local MCP servers + skills). ' +
      'Returns matching ids/descriptions; most are NOT in context. Use mount_capability to load one ' +
      'that is already installed, or to get an install suggestion for a registry server.',
    schema: searchSchema,
    readOnly: true,
    async run(input) {
      if (options.publicSkillSearch) {
        try {
          const remote = await options.publicSkillSearch(input.query, input.limit);
          // Unverified remote hits are ephemeral: evicted after the TTL unless mounted.
          if (remote.length > 0) catalog.upsert([...remote], { ttlMs: REMOTE_SKILL_TTL_MS });
        } catch {
          // public skills are optional enrichment
        }
      }
      const hits = catalog.search(input.query, input.limit).map((e) => {
        const installed =
          options.isInstalled?.(e.id, e) ?? (e.id.startsWith('local:') || Boolean(e.inputSchema));
        return {
          id: e.id,
          kind: e.kind,
          name: e.name,
          description: e.description,
          server: e.server,
          mounted: catalog.isMounted(e.id),
          installed,
          action: installed ? 'mount_capability' : 'install_then_mount',
        };
      });
      return ok(JSON.stringify({ count: hits.length, results: hits }, null, 2));
    },
  };

  const mountTool: Tool<typeof mountSchema> = {
    name: 'mount_capability',
    description:
      'Mount an installed capability into the active set for subsequent turns (LRU-evicts when full). ' +
      'For official-registry servers that are not installed locally, returns an install suggestion ' +
      'instead of downloading or running anything.',
    schema: mountSchema,
    readOnly: false,
    async run(input) {
      const entry = catalog.get(input.id);
      if (!entry) return fail(`Unknown capability id "${input.id}". Search first.`);

      const installed =
        options.isInstalled?.(input.id, entry) ??
        (input.id.startsWith('local:') || Boolean(entry.inputSchema));

      if (!installed) {
        const suggestion =
          options.suggestInstall?.(input.id, entry) ??
          `Capability "${input.id}" is not installed locally. Add it with \`omnexx mcp add <name>\` (or your Omnexx MCP config) before mounting. Omnexx will not auto-install or run untrusted code.`;
        return fail(suggestion);
      }

      const previously = new Set(catalog.getMountedIds());
      const e = catalog.mount(input.id, maxMounted);
      if (!e) return fail(`Could not mount "${input.id}".`);

      if (options.onUnmount) {
        for (const id of previously) {
          if (!catalog.isMounted(id)) {
            try {
              await options.onUnmount(id);
            } catch {
              // best-effort
            }
          }
        }
      }

      let extra = '';
      if (options.onMount) {
        try {
          const msg = await options.onMount(e);
          if (msg) extra = `\n${msg}`;
        } catch (err) {
          catalog.unmount(input.id);
          const m = err instanceof Error ? err.message : String(err);
          return fail(`Mount of ${input.id} failed during live load: ${m}`);
        }
      }
      const schema = e.inputSchema ? `\nSchema: ${JSON.stringify(e.inputSchema)}` : '';
      return ok(
        `Mounted ${e.id} (${e.kind}: ${e.name}). ${e.description}${schema}${extra}\n` +
          `Currently mounted: ${catalog.getMountedIds().join(', ')}`,
      );
    },
  };

  return [searchTool, mountTool];
}

/** Build synthetic catalog entries for tests / benches. */
export function syntheticCatalog(
  count: number,
  prefix = 'mcp:synth',
): Omit<CatalogEntry, 'tokens'>[] {
  const domains = [
    'github',
    'gitlab',
    'jira',
    'slack',
    'browser',
    'db',
    'aws',
    'k8s',
    'email',
    'calendar',
    'docs',
    'ci',
    'docker',
    'npm',
    'python',
  ];
  const verbs = [
    'create',
    'list',
    'get',
    'update',
    'delete',
    'search',
    'run',
    'deploy',
    'query',
    'send',
  ];
  const out: Omit<CatalogEntry, 'tokens'>[] = [];
  for (let i = 0; i < count; i++) {
    const domain = domains[i % domains.length]!;
    const verb = verbs[i % verbs.length]!;
    const name = `${verb}_${domain}_${i}`;
    out.push({
      id: `${prefix}:${domain}:${name}`,
      kind: 'mcp',
      name,
      description: `${verb} a ${domain} resource (#${i}). Use when the user asks to ${verb} ${domain} items.`,
      server: domain,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, payload: { type: 'object' } },
      },
    });
  }
  return out;
}
