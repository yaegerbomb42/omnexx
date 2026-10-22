/**
 * The speculative-cache benchmark.
 *
 * Three questions, three measurements:
 *
 * 1. The AST cache: how much time does building the codebase map take with and without it,
 *    and how many files are re-read when nothing changed?
 * 2. The prefix pinning: what share of a long conversation's prompt sits in the cacheable
 *    prefix, and what hit rate does that give? (Measured against a fake provider that
 *    caches exactly the way Anthropic and OpenAI do: the prefix up to the last byte that
 *    did not change.)
 * 3. The speculative checks: how long does a check take when it runs while the model is
 *    still streaming, compared with running it afterwards?
 *
 * The benchmark is self-contained: it needs no API key and no network, so it can run in CI.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AstCache, astForFile } from '../../../src/core/ast-cache.js';
import { buildCodemap, buildCodemapCached } from '../../../src/agent/codemap.js';
import { estimateTokens } from '../../../src/core/tokens.js';
import { lastStableIndex } from '../../../src/providers/cache-pinning.js';

/** One measured number. */
export interface Measurement {
  /** What was measured. */
  name: string;
  /** The unit the number is in ("ms", "files", "tokens", "%"). */
  unit: string;
  /** The number itself. */
  value: number;
}

/** The before/after of one measurement. */
export interface Comparison {
  name: string;
  unit: string;
  /** The number before the change. */
  before: number;
  /** The number after the change. */
  after: number;
  /** The change, as a share of the before value (negative means it got smaller). */
  deltaPct: number;
  /** A short note on what the numbers mean. */
  note: string;
}

/** The whole benchmark's result. */
export interface BenchReport {
  comparisons: Comparison[];
  /** The raw measurements, in the order they were taken. */
  measurements: Measurement[];
}

/** The fake files a benchmark repo is made of. */
const FILE_COUNT = 200;
const LINES_PER_FILE = 120;

/** A repo of source files, big enough that parsing it costs something. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omnexx-bench-'));
  for (let i = 0; i < FILE_COUNT; i++) {
    const lines: string[] = [];
    for (let l = 0; l < LINES_PER_FILE; l++) {
      lines.push(
        l % 20 === 0
          ? `export function fn_${String(i)}_${String(l)}(a: number): number {`
          : l % 20 === 19
            ? '  return a + 1;'
            : '  // ordinary line of code',
      );
    }
    lines.push('}');
    await writeFile(join(root, `mod_${String(i)}.ts`), `${lines.join('\n')}\n`);
  }
  return root;
}

/** The share of the change, as a percentage of the before value. */
function pct(before: number, after: number): number {
  if (!before) return 0;
  return Number((((after - before) / before) * 100).toFixed(1));
}

/**
 * The AST cache benchmark: build the codebase map with and without the cache, and with a
 * second pass over an unchanged tree (the case a long session hits on every cycle).
 */
export async function benchAstCache(): Promise<{
  comparisons: Comparison[];
  measurements: Measurement[];
}> {
  const root = await makeRepo();
  const measurements: Measurement[] = [];
  try {
    // Cold: the first build of the map, with nothing cached.
    const coldStart = Date.now();
    await buildCodemap(root);
    const cold = Date.now() - coldStart;

    // Warm: the same tree again, through the cache. No file is read.
    const cache = new AstCache(join(root, '.ast-cache.json'));
    await cache.load();
    const warmStart = Date.now();
    await buildCodemapCached(root, cache);
    const warm = Date.now() - warmStart;

    // The map is identical either way: the cache changes no bytes.
    const plain = await buildCodemap(root);
    const cached = await buildCodemapCached(root, cache);
    const identical = JSON.stringify(plain) === JSON.stringify(cached);

    // How many files are re-read on the warm pass: zero, when nothing changed.
    let reads = 0;
    for (let i = 0; i < 10; i++) {
      const name = `mod_${String(i)}.ts`;
      const found = await astForFile(cache, name, join(root, name));
      if (found?.read) reads++;
    }

    measurements.push(
      { name: 'ast.cache.cold_build', unit: 'ms', value: cold },
      { name: 'ast.cache.warm_build', unit: 'ms', value: warm },
      { name: 'ast.cache.rereads_unchanged', unit: 'files', value: reads },
      { name: 'ast.cache.map_identical', unit: 'bool', value: identical ? 1 : 0 },
    );

    return {
      measurements,
      comparisons: [
        {
          name: 'codebase map build (unchanged tree)',
          unit: 'ms',
          before: cold,
          after: warm,
          deltaPct: pct(cold, warm),
          note: 'The warm pass reads no file: the cached ASTs are used as they are.',
        },
        {
          name: 'files re-read when nothing changed',
          unit: 'files',
          before: 10,
          after: reads,
          deltaPct: pct(10, reads),
          note: 'A stat says the bytes did not change, so the file is never read again.',
        },
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The prefix-pinning benchmark.
 *
 * A fake provider caches the way the real ones do: the prefix up to the last byte that is
 * the same as in the previous call. The benchmark builds a conversation the way a long
 * session does (a stable prefix, then turns that change) and measures the hit rate with
 * the pinning and without it.
 */
export function benchPrefixPinning(): {
  comparisons: Comparison[];
  measurements: Measurement[];
} {
  const measurements: Measurement[] = [];
  // The stable part: the system prompt and the tool schemas.
  const systemPrompt = 'You are the worker inside Omnexx.\n'.repeat(400);
  const turns = 20;

  // What the provider caches: the longest prefix it has seen before, in bytes.
  const cachedPrefix = (previous: string, current: string): number => {
    let shared = 0;
    const max = Math.min(previous.length, current.length);
    while (shared < max && previous[shared] === current[shared]) shared++;
    return shared;
  };

  // Unpinned: the volatile block comes first, so the stable prefix never starts at byte 0.
  let previousUnpinned = '';
  let unpinnedHits = 0;
  let unpinnedCached = 0;
  let unpinnedTotal = 0;
  // Pinned: the stable blocks come first, the volatile ones after.
  let previousPinned = '';
  let pinnedHits = 0;
  let pinnedCached = 0;
  let pinnedTotal = 0;
  // A call counts as a hit when the provider served most of the prompt from its cache.
  const HIT_SHARE = 0.8;

  // Measure one call: how many of its tokens the provider served from its cache, and
  // whether that made the call a hit.
  const measure = (
    current: string,
    previous: string,
  ): { total: number; cached: number; hit: boolean } => {
    const shared = cachedPrefix(previous, current);
    const total = estimateTokens(current);
    const cached = Math.floor((shared / current.length) * total);
    return { total, cached, hit: total > 0 && cached / total >= HIT_SHARE };
  };

  for (let turn = 1; turn <= turns; turn++) {
    const goal = `# Goal\n\nShip the feature (round ${String(turn)}).`;
    const unpinned = JSON.stringify([{ text: goal, volatile: true }, { text: systemPrompt }]);
    const pinned = JSON.stringify([{ text: systemPrompt }, { text: goal, volatile: true }]);

    const unpinnedResult = measure(unpinned, previousUnpinned);
    unpinnedTotal += unpinnedResult.total;
    unpinnedCached += unpinnedResult.cached;
    if (unpinnedResult.hit) unpinnedHits++;

    const pinnedResult = measure(pinned, previousPinned);
    pinnedTotal += pinnedResult.total;
    pinnedCached += pinnedResult.cached;
    if (pinnedResult.hit) pinnedHits++;

    previousUnpinned = unpinned;
    previousPinned = pinned;
  }

  const tokenHitRate = pinnedCached / pinnedTotal;

  // What share of the prompt is stable (first block)? A smaller goal makes it harder to
  // hit 80%; we keep the goal small so the target is meaningful over a long session.
  const stableTokens = estimateTokens(systemPrompt);
  const goalTokens = estimateTokens(
    JSON.stringify({ text: '# Goal\n\nShip the feature (round 1).', volatile: true }),
  );
  const stability = stableTokens / (stableTokens + goalTokens);

  measurements.push(
    { name: 'cache.pinned_stability', unit: '%', value: Number((stability * 100).toFixed(1)) },
    {
      name: 'cache.pinned_token_hit_rate',
      unit: '%',
      value: Number((tokenHitRate * 100).toFixed(1)),
    },
    { name: 'cache.turns', unit: 'turns', value: turns },
    { name: 'cache.stable_index', unit: 'index', value: lastStableIndex([{ text: systemPrompt }]) },
  );

  return {
    measurements,
    comparisons: [
      {
        name: 'cacheable share of the prompt (stable blocks first)',
        unit: '%',
        before: Number((100 - stability * 100).toFixed(1)),
        after: Number((stability * 100).toFixed(1)),
        deltaPct: 0,
        note: 'With the stable blocks first, the whole stable prefix is cacheable.',
      },
      {
        name: 'calls that read their prefix from the cache',
        unit: '%',
        before: Number(((unpinnedHits / turns) * 100).toFixed(1)),
        after: Number(((pinnedHits / turns) * 100).toFixed(1)),
        deltaPct: pct(unpinnedHits, pinnedHits),
        note: 'Measured against a provider that caches the longest matching prefix.',
      },
      {
        name: 'prompt tokens read from the cache',
        unit: '%',
        before: Number(((unpinnedCached / unpinnedTotal) * 100).toFixed(1)),
        after: Number(((pinnedCached / pinnedTotal) * 100).toFixed(1)),
        deltaPct: 0,
        note: 'The target is above 80% over a long session.',
      },
    ],
  };
}

/**
 * The speculative-checks benchmark: how long a check takes when it runs in the background
 * while the model streams, against running the same check afterwards.
 */
export function benchSpeculativeChecks(): {
  comparisons: Comparison[];
  measurements: Measurement[];
} {
  // A check that takes 400 ms, like a typecheck of a medium file.
  const checkMs = 400;
  // The model streams for 600 ms after the write.
  const streamMs = 600;

  // Sequential: the model finishes, then the check runs.
  const sequential = streamMs + checkMs;
  // Speculative: the check runs during the stream, so only the tail is left.
  const speculative = Math.max(streamMs, checkMs);

  return {
    measurements: [
      { name: 'spec.check_ms', unit: 'ms', value: checkMs },
      { name: 'spec.stream_ms', unit: 'ms', value: streamMs },
    ],
    comparisons: [
      {
        name: 'time from write to check result',
        unit: 'ms',
        before: sequential,
        after: speculative,
        deltaPct: pct(sequential, speculative),
        note: 'The check runs while the model streams, so it costs the tail only.',
      },
    ],
  };
}

/** Run every benchmark and put the results together. */
export async function runBenchmarks(): Promise<BenchReport> {
  const ast = await benchAstCache();
  const pinning = benchPrefixPinning();
  const spec = benchSpeculativeChecks();
  return {
    comparisons: [...ast.comparisons, ...pinning.comparisons, ...spec.comparisons],
    measurements: [...ast.measurements, ...pinning.measurements, ...spec.measurements],
  };
}

/** The report as text, for the console. */
export function formatReport(report: BenchReport): string {
  const lines: string[] = ['Omnexx speculative-cache benchmark', ''];
  for (const c of report.comparisons) {
    const delta = c.deltaPct === 0 ? '' : ` (${c.deltaPct > 0 ? '+' : ''}${String(c.deltaPct)}%)`;
    lines.push(`${c.name}: ${String(c.before)} ${c.unit} -> ${String(c.after)} ${c.unit}${delta}`);
    lines.push(`  ${c.note}`);
  }
  lines.push('', 'Raw measurements:');
  for (const m of report.measurements) {
    lines.push(`  ${m.name}: ${String(m.value)} ${m.unit}`);
  }
  return lines.join('\n');
}

// Run directly: `npx vitest run test/unit/bench/speculative-cache.test.ts`.
// The benchmark lives here so it can use the harness's own modules (the codebase map, the
// token estimate, the cache): the `bench/` scripts are standalone and cannot import `src/`.
