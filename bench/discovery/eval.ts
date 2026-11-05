/**
 * Capability discovery eval: recall/precision/MRR/latency of the kernel's catalog ranking
 * against realistic tasks (tasks.json) over the real MCP Registry snapshot + a simulated
 * local environment. Usage: npx tsx bench/discovery/eval.ts [--snapshot path] [--ranker name] [--json]
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityCatalog, type CatalogEntry } from '../../src/runtime/kernel/catalog.js';
import { CapabilityRetriever } from '../../src/runtime/kernel/retrieval.js';
import { DenseIndex } from '../../src/runtime/kernel/dense.js';
import { mergeLocalWithRegistry } from '../../src/runtime/kernel/kernel.js';
import { toCatalogEntries, type RegistrySnapshot } from '../../src/runtime/kernel/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const snapPath =
  arg('--snapshot') ??
  join(here, '..', '..', 'src', 'runtime', 'kernel', 'data', 'mcp-registry-snapshot.json.gz');

interface Task {
  q: string;
  groups: string[][];
  installed?: string;
}
const spec = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')) as {
  local: { mcp: string[]; skills: [string, string][]; tools: [string, string][] };
  tasks: Task[];
};
if (args.includes('--heldout')) {
  spec.tasks = (
    JSON.parse(readFileSync(join(here, 'heldout.json'), 'utf8')) as { tasks: Task[] }
  ).tasks;
}

export function buildCatalog(snapshotPath = snapPath): {
  catalog: CapabilityCatalog;
  loadMs: number;
} {
  const t0 = performance.now();
  const snap = JSON.parse(
    gunzipSync(readFileSync(snapshotPath)).toString('utf8'),
  ) as RegistrySnapshot;
  const entries: Omit<CatalogEntry, 'tokens'>[] = [];
  for (const [name, description] of spec.local.tools)
    entries.push({ id: `local:tool:${name}`, kind: 'tool', name, description });
  for (const [name, description] of spec.local.skills)
    entries.push({ id: `local:skill:${name}`, kind: 'skill', name, description });
  for (const name of spec.local.mcp)
    entries.push({
      id: `local:mcp:${name}`,
      kind: 'mcp',
      name,
      description: `Locally configured MCP server "${name}" (claude-desktop)`,
      server: name,
    });
  const byId = new Map(snap.servers.map((s) => [s.id, s]));
  const merged = mergeLocalWithRegistry(
    entries,
    toCatalogEntries(snap),
    (id) => byId.get(id)?.install?.identifier,
  );
  const catalog = new CapabilityCatalog();
  catalog.load(merged);
  return { catalog, loadMs: performance.now() - t0 };
}

function tailTokens(e: CatalogEntry): { tail: string; toks: Set<string> } {
  const tail = (e.server ?? e.name).split('/').pop()?.toLowerCase() ?? '';
  const toks = new Set([...tail.split(/[^a-z0-9]+/), ...e.name.toLowerCase().split(/[^a-z0-9]+/)]);
  return { tail, toks };
}

export function relevant(e: CatalogEntry, kws: string[]): boolean {
  const { tail, toks } = tailTokens(e);
  return kws.some((k) =>
    k.includes('-') ? tail.includes(k) || e.name.toLowerCase() === k : toks.has(k),
  );
}

export type Ranker = (
  catalog: CapabilityCatalog,
  query: string,
  k: number,
) => CatalogEntry[] | Promise<CatalogEntry[]>;

export async function evaluate(catalog: CapabilityCatalog, rank: Ranker, k = 10) {
  let groups = 0;
  let hit5 = 0;
  let hit10 = 0;
  let full5 = 0;
  let mrr = 0;
  let prec5 = 0;
  let instTasks = 0;
  let inst1 = 0;
  let inst3 = 0;
  const lat: number[] = [];
  const misses: string[] = [];
  for (const t of spec.tasks) {
    const t0 = performance.now();
    const top = await rank(catalog, t.q, k);
    lat.push(performance.now() - t0);
    let covered5 = 0;
    for (const g of t.groups) {
      groups++;
      const idx = top.findIndex((e) => relevant(e, g) || e.id === t.installed);
      if (idx >= 0 && idx < 5) {
        hit5++;
        covered5++;
      }
      if (idx >= 0 && idx < 10) hit10++;
      if (idx >= 0) mrr += 1 / (idx + 1);
      else
        misses.push(
          `${t.q.slice(0, 50)} [${g[0]}] -> ${top
            .slice(0, 3)
            .map((e) => e.id)
            .join(', ')}`,
        );
    }
    if (covered5 === t.groups.length) full5++;
    const top5 = top.slice(0, 5);
    prec5 +=
      top5.filter((e) => t.groups.some((g) => relevant(e, g)) || e.id === t.installed).length / 5;
    if (t.installed) {
      instTasks++;
      const i = top.findIndex((e) => e.id === t.installed);
      if (i === 0) inst1++;
      if (i >= 0 && i < 3) inst3++;
    }
  }
  lat.sort((a, b) => a - b);
  const n = spec.tasks.length;
  return {
    tasks: n,
    groups,
    recall5: +(hit5 / groups).toFixed(3),
    recall10: +(hit10 / groups).toFixed(3),
    allGroups5: +(full5 / n).toFixed(3),
    mrr: +(mrr / groups).toFixed(3),
    precision5: +(prec5 / n).toFixed(3),
    installedTop1: +(inst1 / instTasks).toFixed(3),
    installedTop3: +(inst3 / instTasks).toFixed(3),
    p50ms: +(lat[Math.floor(n * 0.5)] ?? 0).toFixed(1),
    p95ms: +(lat[Math.floor(n * 0.95)] ?? 0).toFixed(1),
    misses,
  };
}

let retriever: CapabilityRetriever | undefined;
const denseWeight = Number(arg('--dense-weight') ?? 0.5);
const denseRerank = new DenseIndex({ cachePath: '/home/box/models/dense-rerank-cache.json.gz' });
const denseFull = new DenseIndex({ cachePath: '/home/box/models/dense-cache.json.gz' });
/**
 * Mount-set quality: what the kernel would actually put in context (maxMounted slots),
 * plus churn across a 4-turn session per task (same goal, drifting wording + an error).
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async API kept for callers
export async function evaluateSelect(
  makeCatalog: () => CapabilityCatalog,
  maxMounted = 6,
  mode: 'topk' | 'select' = 'select',
) {
  let groups = 0;
  let covered = 0;
  let relevantMounted = 0;
  let mountedTotal = 0;
  let churn = 0;
  const catalog = makeCatalog();
  for (const t of spec.tasks) {
    for (const id of catalog.getMountedIds()) catalog.unmount(id);
    const turns = [
      t.q,
      `${t.q}\nprogress: first step done`,
      `${t.q}\nlast tool error: request failed with 401 unauthorized`,
      `${t.q}\ncontinue`,
    ];
    let first: string[] = [];
    for (const [i, q] of turns.entries()) {
      const ids =
        mode === 'topk'
          ? catalog.search(q, maxMounted).map((e) => e.id)
          : catalog.select({ query: q, maxMounted }).mounted.map((e) => e.id);
      if (mode === 'topk') {
        for (const id of catalog.getMountedIds()) catalog.unmount(id);
        for (const id of ids) catalog.mount(id, maxMounted);
      }
      if (i === 0) {
        first = ids;
        const mounted = ids.map((id) => catalog.get(id)).filter((e): e is CatalogEntry => !!e);
        mountedTotal += mounted.length;
        for (const g of t.groups) {
          groups++;
          if (mounted.some((e) => relevant(e, g) || e.id === t.installed)) covered++;
        }
        // Distinct groups served: duplicate servers for the same product are waste.
        relevantMounted += t.groups.filter((g) =>
          mounted.some((e) => relevant(e, g) || e.id === t.installed),
        ).length;
      } else {
        churn += ids.filter((id) => !first.includes(id)).length;
        first = ids;
      }
    }
  }
  const n = spec.tasks.length;
  return {
    mode,
    maxMounted,
    coverage: +(covered / groups).toFixed(3),
    slotEfficiency: +(relevantMounted / Math.max(1, mountedTotal)).toFixed(3),
    avgMounted: +(mountedTotal / n).toFixed(2),
    churnPerTurn: +(churn / (n * 3)).toFixed(2),
  };
}

const rankers: Record<string, Ranker> = {
  search: (c, q, k) => c.search(q, k),
  'hybrid-rerank': async (c, q, k) =>
    (await c.rankHybrid(q, k, denseRerank, { denseWeight })).map((r) => r.entry),
  'hybrid-full': async (c, q, k) =>
    (await c.rankHybrid(q, k, denseFull, { denseWeight })).map((r) => r.entry),
  bm25: (c, q, k) => {
    if (!retriever) {
      retriever = new CapabilityRetriever();
      retriever.build(c.allEntries());
    }
    return retriever
      .rank(q, k, { isInstalled: (d) => d.id.startsWith('local:') })
      .map((r) => c.get(r.doc.id))
      .filter((e): e is CatalogEntry => e !== undefined);
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (args.includes('--select')) {
    const mode = (arg('--select-mode') ?? 'select') as 'topk' | 'select';
    console.log(JSON.stringify(await evaluateSelect(() => buildCatalog().catalog, 6, mode)));
    process.exit(0);
  }
  const name = arg('--ranker') ?? 'search';
  const { catalog, loadMs } = buildCatalog();
  if (name === 'hybrid-full') await denseFull.load();
  if (name === 'hybrid-rerank') await denseRerank.load();
  const ranker = rankers[name];
  if (!ranker) throw new Error(`unknown ranker ${name}`);
  const r = await evaluate(catalog, ranker);
  const { misses, ...summary } = r;
  console.log(
    JSON.stringify({
      ranker: name,
      catalogSize: catalog.size,
      loadMs: Math.round(loadMs),
      ...summary,
    }),
  );
  await denseRerank.save();
  if (args.includes('--misses')) for (const m of misses) console.log('  miss:', m);
}
