import { mkdir, writeFile } from 'node:fs/promises';
import { readJsonFile, runCommand } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

interface BenchResult {
  name?: string;
  hz?: number;
  /** vitest bench JSON uses `samples`/`median`; keep the raw shape loose. */
  samples?: number[];
  median?: number;
  rme?: number;
}

interface BenchReport {
  benchmarks?: BenchResult[];
  files?: { name?: string; benchmarks?: BenchResult[] }[];
}

interface BaselineEntry {
  medianMs: number;
  /** Consecutive runs in which this benchmark regressed >15% vs baseline. */
  consecutiveRegressions: number;
}

type Baseline = Record<string, BaselineEntry>;

/** Queue only regressions above this fraction vs the stored baseline. */
const REGRESSION_THRESHOLD = 0.15;
/** Queue only after this many consecutive regressing runs (guards against noise). */
const REQUIRED_REGRESSION_RUNS = 3;

/**
 * Runs `vitest bench` when bench files exist and compares against the stored
 * baseline (`.omnexx/perf-baseline.json`). A benchmark is queued only when it
 * regresses >15% in 3 consecutive runs, with the concrete hot function named.
 *
 * First run with no baseline: records the baseline and returns [].
 * No bench files: returns [] without running anything.
 */
export class PerfBenchmarkCollector implements DiscoveryCollector {
  readonly name = 'perf_benchmark';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const benchFiles = await findBenchFiles(repoRoot);
    if (benchFiles.length === 0) return findings;

    const result = await runCommand(
      'npx',
      ['vitest', 'bench', '--run', '--outputJson', '.omnexx/discovery/bench-result.json'],
      repoRoot,
      300_000,
    );
    if (result.timedOut) return findings;
    const report = await readJsonFile<BenchReport>(
      `${repoRoot}/.omnexx/discovery/bench-result.json`,
    );
    if (!report) return findings;

    const current = flattenBenchmarks(report);
    if (current.size === 0) return findings;

    const baselinePath = `${repoRoot}/.omnexx/perf-baseline.json`;
    const baseline = await readJsonFile<Baseline>(baselinePath);
    if (!baseline) {
      // No baseline yet: record one and queue nothing.
      await writeBaseline(baselinePath, toBaseline(current));
      return findings;
    }

    const nextBaseline: Baseline = { ...baseline };
    for (const [name, medianMs] of current) {
      const entry = baseline[name];
      if (!entry) {
        nextBaseline[name] = { medianMs, consecutiveRegressions: 0 };
        continue;
      }
      const regression = (medianMs - entry.medianMs) / entry.medianMs;
      if (regression > REGRESSION_THRESHOLD) {
        const consecutive = entry.consecutiveRegressions + 1;
        nextBaseline[name] = { medianMs: entry.medianMs, consecutiveRegressions: consecutive };
        if (consecutive >= REQUIRED_REGRESSION_RUNS) {
          findings.push(
            makeFinding({
              collector: this.name,
              ruleOrTestId: `perf-regression:${name}`,
              targetFiles: benchFilesFor(name, benchFiles),
              severity: 0.7,
              confidence: 0.85,
              verification: 0.8,
              findingPayload: {
                kind: 'perf-regression',
                benchmark: name,
                baselineMedianMs: entry.medianMs,
                currentMedianMs: medianMs,
                regressionPct: Math.round(regression * 1000) / 10,
                consecutiveRegressions: consecutive,
                note: `Regressed >${REGRESSION_THRESHOLD * 100}% vs baseline in ${consecutive} consecutive runs.`,
              },
            }),
          );
        }
      } else {
        // Back within tolerance: reset the streak and adopt the new (better) median.
        nextBaseline[name] = {
          medianMs: Math.min(entry.medianMs, medianMs),
          consecutiveRegressions: 0,
        };
      }
    }
    await writeBaseline(baselinePath, nextBaseline);
    return findings;
  }
}

async function findBenchFiles(repoRoot: string): Promise<string[]> {
  const result = await runCommand(
    'git',
    ['ls-files', '*.bench.ts', '*.bench.tsx', 'bench/**/*.ts'],
    repoRoot,
    30_000,
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

function flattenBenchmarks(report: BenchReport): Map<string, number> {
  const out = new Map<string, number>();
  const add = (name: string | undefined, r: BenchResult): void => {
    if (!name) return;
    const medianMs = medianOf(r);
    if (medianMs !== undefined) out.set(name, medianMs);
  };
  for (const b of report.benchmarks ?? []) add(b.name, b);
  for (const file of report.files ?? []) {
    for (const b of file.benchmarks ?? []) {
      add(b.name ?? `${file.name ?? 'bench'} > unnamed`, b);
    }
  }
  return out;
}

/** Median run time in ms. Vitest bench reports hz (ops/sec) and/or samples (sec). */
function medianOf(result: BenchResult): number | undefined {
  if (typeof result.median === 'number' && Number.isFinite(result.median)) {
    return result.median * 1000; // vitest bench median is in seconds
  }
  if (Array.isArray(result.samples) && result.samples.length > 0) {
    const sorted = [...result.samples].sort((a, b) => a - b);
    return (sorted[Math.floor(sorted.length / 2)] as number) * 1000;
  }
  if (typeof result.hz === 'number' && result.hz > 0) return 1000 / result.hz;
  return undefined;
}

function toBaseline(current: Map<string, number>): Baseline {
  const baseline: Baseline = {};
  for (const [name, medianMs] of current) {
    baseline[name] = { medianMs, consecutiveRegressions: 0 };
  }
  return baseline;
}

async function writeBaseline(path: string, baseline: Baseline): Promise<void> {
  try {
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  } catch {
    // Baseline persistence is best effort.
  }
}

function benchFilesFor(benchmarkName: string, benchFiles: string[]): string[] {
  const match = benchFiles.find((f) => benchmarkName.includes(f));
  return match ? [match] : benchFiles.slice(0, 1);
}
