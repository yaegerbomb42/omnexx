import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import type { Efficiency } from './efficiency.ts';
import type { TaskRunResult, BenchConfig } from './types.ts';
import { createMutex } from './pool.ts';

/** Results writer: outputs markdown table + raw JSONL. */
/** Every result set lives here, under a name; nothing is written anywhere else. */
export const RESULTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'results');

/** `--out lean` → bench/results/lean. Only the last path segment counts, in safe characters. */
export function resultsDir(out: string): string {
  const name =
    basename(out)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '') || 'results';
  return join(RESULTS_ROOT, name);
}

export class ResultsWriter {
  private readonly outDir: string;
  private readonly jsonlPath: string;
  private readonly mdPath: string;
  private readonly runId: string;
  /** Concurrent runs finish at once: each append + markdown rebuild runs alone, in order. */
  private readonly serial = createMutex();

  constructor(config: BenchConfig) {
    this.outDir = resultsDir(config.out);
    const runId = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0]; // YYYY-MM-DD
    this.runId = runId ?? '';
    this.jsonlPath = join(this.outDir, `${this.runId}.jsonl`);
    this.mdPath = join(this.outDir, `${this.runId}.md`);

    if (!existsSync(this.outDir)) {
      mkdirSync(this.outDir, { recursive: true });
    }
  }

  /** Write a single task result (appends to JSONL, rebuilds markdown). */
  writeResult(result: TaskRunResult): Promise<void> {
    return this.writeResults([result]);
  }

  /** Write multiple results at once. */
  writeResults(results: TaskRunResult[]): Promise<void> {
    return this.serial(async () => {
      const lines = results.map((r) => JSON.stringify(r) + '\n').join('');
      if (lines) await appendFile(this.jsonlPath, lines, 'utf-8');
      await this.rebuildMarkdown();
    });
  }

  /** Get the output directory. */
  getOutDir(): string {
    return this.outDir;
  }

  /** Get the run ID. */
  getRunId(): string {
    return this.runId;
  }

  private async rebuildMarkdown(): Promise<void> {
    // Read all results from JSONL
    const fs = await import('node:fs/promises');
    let results: TaskRunResult[] = [];
    try {
      const content = await fs.readFile(this.jsonlPath, 'utf-8');
      const parsed = content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskRunResult);
      results = parsed;
    } catch {
      // File doesn't exist yet
    }

    // Group by suite
    const bySuite = new Map<string, TaskRunResult[]>();
    for (const r of results) {
      const suiteResults = bySuite.get(r.suite) ?? [];
      suiteResults.push(r);
      bySuite.set(r.suite, suiteResults);
    }

    // Build markdown
    let md = `# Benchmark Results - ${this.runId}\n\n`;
    md += `Generated: ${new Date().toISOString()}\n\n`;

    for (const [suite, suiteResults] of bySuite) {
      md += `## Suite: ${suite}\n\n`;
      md += this.buildTable(suiteResults);
      md += '\n';
    }

    await writeFile(this.mdPath, md, 'utf-8');
  }

  private buildTable(results: TaskRunResult[]): string {
    if (results.length === 0) {
      return '*No results yet*\n';
    }

    // Sort by agent, then taskId
    results.sort(
      (a, b) =>
        a.agent.localeCompare(b.agent) ||
        a.taskId.localeCompare(b.taskId) ||
        (a.rep ?? 1) - (b.rep ?? 1),
    );

    const header = [...BASE_COLUMNS, ...EFFICIENCY_COLUMNS];
    let table = `| ${header.join(' | ')} |\n`;
    table += `|${header.map(() => '---').join('|')}|\n`;

    for (const r of results) {
      const m = r.metrics;
      table += `| ${[
        r.taskId,
        String(r.rep ?? 1),
        r.agent,
        m.resolved ? '✅' : '❌',
        `$${m.usd.toFixed(4)}`,
        m.tokens_in.toLocaleString(),
        m.tokens_out.toLocaleString(),
        m.cached.toLocaleString(),
        seconds(m.wall_ms),
        String(m.interventions),
        ...efficiencyCells(m.efficiency),
      ].join(' | ')} |\n`;
    }

    for (const [agent, rows] of byAgent(results)) table += summaryRow(agent, rows);
    return table;
  }
}

const BASE_COLUMNS = [
  'Task',
  'Rep',
  'Agent',
  'Resolved',
  'USD',
  'Tokens In',
  'Tokens Out',
  'Cached',
  'Wall Time',
  'Interventions',
];
const EFFICIENCY_COLUMNS = [
  'Turns',
  'Calls/turn',
  'Multi-call turns',
  'Bookkeeping',
  'Gates',
  'Idle',
  'Fresh/turn',
  'Cache',
];

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const percent = (share: number): string => `${(share * 100).toFixed(0)}%`;

/** The efficiency cells of a row; "-" for harnesses that log no events. */
export function efficiencyCells(e: Efficiency | undefined): string[] {
  if (!e) return EFFICIENCY_COLUMNS.map(() => '-');
  return [
    String(e.turns),
    e.calls_per_turn.toFixed(2),
    String(e.multi_call_turns),
    percent(e.bookkeeping_share),
    seconds(e.gate_ms),
    seconds(e.idle_ms),
    e.fresh_per_turn.toLocaleString(),
    percent(e.cache_share),
  ];
}

function byAgent(results: readonly TaskRunResult[]): Map<string, TaskRunResult[]> {
  const groups = new Map<string, TaskRunResult[]>();
  for (const r of results) groups.set(r.agent, [...(groups.get(r.agent) ?? []), r]);
  return groups;
}

const mean = (xs: readonly number[]): number =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

/** One agent's totals: resolved count, mean cost and wall time, summed tokens, mean efficiency. */
export function summaryRow(agent: string, rows: readonly TaskRunResult[]): string {
  const ms = rows.map((r) => r.metrics);
  const sum = (pick: (m: TaskRunResult['metrics']) => number): number =>
    ms.reduce((s, m) => s + pick(m), 0);
  const effs = ms.flatMap((m) => (m.efficiency ? [m.efficiency] : []));
  const eff: Efficiency | undefined = effs.length
    ? {
        turns: Math.round(mean(effs.map((e) => e.turns))),
        tool_calls: Math.round(mean(effs.map((e) => e.tool_calls))),
        calls_per_turn: mean(effs.map((e) => e.calls_per_turn)),
        multi_call_turns: Math.round(mean(effs.map((e) => e.multi_call_turns))),
        bookkeeping_share: mean(effs.map((e) => e.bookkeeping_share)),
        gate_ms: mean(effs.map((e) => e.gate_ms)),
        idle_ms: mean(effs.map((e) => e.idle_ms)),
        fresh_per_turn: Math.round(mean(effs.map((e) => e.fresh_per_turn))),
        cache_share: mean(effs.map((e) => e.cache_share)),
      }
    : undefined;
  return `| ${[
    '**Summary**',
    '-',
    agent,
    `${String(ms.filter((m) => m.resolved).length)}/${String(ms.length)}`,
    `$${(sum((m) => m.usd) / ms.length).toFixed(4)}`,
    sum((m) => m.tokens_in).toLocaleString(),
    sum((m) => m.tokens_out).toLocaleString(),
    sum((m) => m.cached).toLocaleString(),
    seconds(sum((m) => m.wall_ms) / ms.length),
    String(sum((m) => m.interventions)),
    ...efficiencyCells(eff),
  ].join(' | ')} |\n`;
}

/** Create a results writer for the given config. */
export function createResultsWriter(config: BenchConfig): ResultsWriter {
  return new ResultsWriter(config);
}
