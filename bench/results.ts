import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
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

    let table =
      '| Task | Rep | Agent | Resolved | USD | Tokens In | Tokens Out | Cached | Wall Time | Interventions |\n';
    table +=
      '|------|-----|-------|----------|-----|-----------|------------|--------|-----------|---------------|\n';

    for (const r of results) {
      const m = r.metrics;
      const wallSec = (m.wall_ms / 1000).toFixed(1);
      table += `| ${r.taskId} | ${String(r.rep ?? 1)} | ${r.agent} | ${m.resolved ? '✅' : '❌'} | $${m.usd.toFixed(4)} | ${m.tokens_in.toLocaleString()} | ${m.tokens_out.toLocaleString()} | ${m.cached.toLocaleString()} | ${wallSec}s | ${m.interventions} |\n`;
    }

    // Add summary row
    const resolved = results.filter((r) => r.metrics.resolved).length;
    const total = results.length;
    const avgUsd = results.reduce((sum, r) => sum + r.metrics.usd, 0) / total;
    const avgWall = results.reduce((sum, r) => sum + r.metrics.wall_ms, 0) / total;
    const firstAgent = results[0]?.agent ?? 'unknown';
    table += `| **Summary** | - | ${firstAgent} | ${resolved}/${total} | $${avgUsd.toFixed(4)} | - | - | - | ${(avgWall / 1000).toFixed(1)}s | - |\n`;

    return table;
  }
}

/** Create a results writer for the given config. */
export function createResultsWriter(config: BenchConfig): ResultsWriter {
  return new ResultsWriter(config);
}
