import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import pc from 'picocolors';
import { EXIT } from '../../exit-codes.js';
import { println, type CliIO } from '../../io.js';
import { resolvePaths } from '../../../core/paths.js';
import { RunStore, listRunIds } from '../../../core/run-store.js';
import { readEvents, type OmnexxEvent } from '../../../core/events.js';
import { collectRunStats, runStatsToJsonl, type RunStats } from '../../../telemetry/aggregate.js';

export async function statsCommand(
  io: CliIO,
  runId: string | undefined,
  opts: { json?: boolean; jsonl?: boolean; fixture?: string },
): Promise<number> {
  let stats: RunStats | undefined;

  if (opts.fixture) {
    // Read from fixture file for testing
    const text = await readFile(opts.fixture, 'utf8');
    const events = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as OmnexxEvent);
    stats = collectRunStats(events, 'fixture');
  } else {
    const paths = resolvePaths(io.env);
    const ids = await listRunIds(paths);
    if (!ids.length) {
      println(io.stderr, 'no runs yet');
      return EXIT.error;
    }
    const targetId = runId ?? ids.at(-1);
    if (!targetId) {
      println(io.stderr, 'no runs yet');
      return EXIT.error;
    }
    const store = new RunStore(paths, targetId);
    const events = await readEvents(store.eventsPath);
    const state = await store.readState();
    stats = collectRunStats(events, targetId);
    stats.mode = `${state.executionMode}/${state.workDomain}`;
  }

  // stats is always populated here (either from fixture or from events + readState)

  if (opts.json) {
    println(io.stdout, JSON.stringify(stats, null, 2));
    return EXIT.ok;
  }

  if (opts.jsonl) {
    println(io.stdout, runStatsToJsonl(stats));
    return EXIT.ok;
  }

  // Human-readable output
  const b = pc;
  const s = stats;
  const tot = s.totals;

  println(io.stdout, b.bold(`Run ${s.runId} · ${s.status} · ${s.mode}`));
  println(io.stdout, '');
  println(
    io.stdout,
    [
      b.green(`  ✓ ${s.totals.commits} commits`),
      s.totals.toolErrors ? b.red(`  ✗ ${s.totals.toolErrors} tool errors`) : '  ✗ 0 tool errors',
      b.cyan(`  ${tot.turns} turns`),
      b.yellow(`  ${tot.toolCalls} tool calls`),
      b.magenta(`  $${tot.usd.toFixed(2)}`),
      `  ${fmtDuration(tot.durationMs)}`,
      `  cache ${Math.round(s.cacheHitRate * 100)}%`,
    ].join(' · '),
  );
  println(io.stdout, '');

  println(io.stdout, b.bold('Per-task:'));
  for (const t of s.tasks) {
    const turnRate =
      t.turns > 0 ? ` ${fmtTokensPerTurn(t.tokens.input + t.tokens.output, t.turns)} tok/turn` : '';
    println(
      io.stdout,
      `  ${b.cyan(t.taskId.padEnd(8))} ${String(t.turns).padStart(3)} turns · ${fmtTokens(t.tokens.input + t.tokens.output).padStart(6)} tok · ${fmtDuration(t.durationMs).padStart(6)} · $${t.usd.toFixed(4)}${turnRate}`,
    );
  }

  println(io.stdout, '');
  println(io.stdout, b.bold('Percentiles:'));
  println(
    io.stdout,
    `  turns/task   p50 ${String(s.turnsPerTask.p50).padStart(4)}  p95 ${String(s.turnsPerTask.p95).padStart(4)}`,
  );
  println(
    io.stdout,
    `  latency/turn p50 ${String(s.latencyPerTurnMs.p50).padStart(5)}ms  p95 ${String(s.latencyPerTurnMs.p95).padStart(5)}ms`,
  );
  println(
    io.stdout,
    `  tokens/task  p50 ${fmtTokens(s.tokensPerTask.p50).padStart(6)}  p95 ${fmtTokens(s.tokensPerTask.p95).padStart(6)}`,
  );

  return EXIT.ok;
}

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m${Math.round((ms % 60_000) / 1_000)}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTokensPerTurn(total: number, turns: number): string {
  if (turns === 0) return '0';
  const per = total / turns;
  if (per >= 1_000) return `${(per / 1_000).toFixed(1)}k`;
  return String(Math.round(per));
}

/** Registers `omnexx stats` command. */
export function register(program: Command, io: CliIO, setExit: (code: number) => void): void {
  program
    .command('stats')
    .argument('[runId]', 'defaults to the most recent run')
    .option('--json', 'machine-readable output')
    .option('--jsonl', 'single JSONL line for log aggregation')
    .option('--fixture <path>', 'read events from a fixture file (for testing)')
    .description(
      'efficiency metrics: tokens/task, cache ratio, turns, p50/p95 latency per run and mode',
    )
    .action(
      async (
        runId: string | undefined,
        opts: { json?: boolean; jsonl?: boolean; fixture?: string },
      ) => {
        setExit(await statsCommand(io, runId, opts));
      },
    );
}
