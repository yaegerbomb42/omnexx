/**
 * `omnexx kernel`: observe-only snapshot of the adaptive runtime kernel from the latest run
 * (or `--run <id>`): phase, active capabilities with why, cadence decisions, savings, KV-cache
 * economics and the bandit's top learned priors.
 */
import pc from 'picocolors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../../core/events.js';
import { resolvePaths, runDir, usageFile } from '../../core/paths.js';
import { cacheSummary } from '../../providers/cache-stats.js';
import { readUsageLedger, summarizeUsage } from '../../providers/usage-ledger.js';
import { cadenceLabel, snapshotFromAllocateEvent } from '../../runtime/kernel/observe.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';
import { latestRunDir } from './usage.js';

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export async function kernelStatus(
  io: CliIO,
  opts: { run?: string; json?: boolean; cwd?: string },
): Promise<number> {
  const p = resolvePaths(io.env);
  const dir = opts.run ? runDir(p, opts.run) : await latestRunDir(p);
  const events = dir ? await readEvents(join(dir, 'events.jsonl')) : [];
  const allocs = events.filter((e) => e.type === 'kernel.allocate');
  const last = allocs.at(-1);
  let bandit: { arms?: Record<string, { pulls: number; progressReward: number }> } = {};
  try {
    bandit = JSON.parse(
      readFileSync(join(opts.cwd ?? process.cwd(), '.omnexx', 'kernel-bandit.json'), 'utf8'),
    ) as typeof bandit;
  } catch {
    // no learned priors yet
  }
  const priors = Object.entries(bandit.arms ?? {})
    .filter(([, a]) => a.pulls >= 0.5)
    .map(([arm, a]) => ({ arm, pulls: a.pulls, mean: a.progressReward / a.pulls }))
    .sort((a, b) => b.mean * Math.log1p(b.pulls) - a.mean * Math.log1p(a.pulls))
    .slice(0, 5);
  const records = readUsageLedger(usageFile(p));
  const report = records.length ? summarizeUsage(records, '') : undefined;
  const cache = report
    ? cacheSummary({
        input: report.inputTokens,
        cacheRead: report.cacheRead,
        output: report.outputTokens,
        usd: report.usd,
      })
    : undefined;
  const cadences: Record<string, number> = {};
  for (const e of allocs) {
    const c = typeof e.cadence === 'string' ? e.cadence : 'n/a';
    cadences[c] = (cadences[c] ?? 0) + 1;
  }
  const snap = last ? snapshotFromAllocateEvent(last) : null;
  if (opts.json) {
    println(
      io.stdout,
      JSON.stringify({ run: dir ?? null, snapshot: snap, cadences, cache, priors }, null, 2),
    );
    return EXIT.ok;
  }
  println(io.stdout, pc.bold('Kernel'));
  if (!snap) println(io.stdout, pc.dim(`  no kernel.allocate events${dir ? ` in ${dir}` : ''}`));
  else {
    println(
      io.stdout,
      `  phase ${pc.magenta(snap.phase)} · ${snap.taskClass} · tier ${String(snap.tier)} · rank ${snap.rank} · turn ${String(snap.turn)}`,
    );
    println(io.stdout, `  cadence ${cadenceLabel(snap)}`);
    println(io.stdout, pc.bold('  Active capabilities'));
    if (!snap.active.length) println(io.stdout, pc.dim('    core tools only'));
    for (const a of snap.active) println(io.stdout, `    ${a.id}  ${pc.dim(a.why)}`);
    if (snap.mountSavings)
      println(
        io.stdout,
        `  selective mount: ${k(snap.mountSavings.mountedTokens)} of ${k(snap.mountSavings.catalogTokens)} tool tokens mounted (${k(Math.max(0, snap.mountSavings.catalogTokens - snap.mountSavings.mountedTokens))}/turn saved)`,
      );
    println(
      io.stdout,
      `  decisions: ${Object.entries(cadences)
        .map(([c, n]) => `${c} ${String(n)}`)
        .join(' · ')}`,
    );
  }
  if (cache)
    println(
      io.stdout,
      `  KV cache: ${String(cache.hitPercent)}% hit · ~${k(Math.max(0, cache.savedTokens))} tokens · ~$${Math.max(0, cache.savedUsd).toFixed(4)} saved`,
    );
  println(io.stdout, pc.bold('  Bandit top priors'));
  if (!priors.length) println(io.stdout, pc.dim('    none learned yet'));
  for (const pr of priors)
    println(
      io.stdout,
      `    ${pr.arm.padEnd(40)} mean ${pr.mean.toFixed(2)}  pulls ${pr.pulls.toFixed(1)}`,
    );
  return EXIT.ok;
}

export const register: CommandRegistrar = (program, io, setExit) => {
  program
    .command('kernel')
    .option('--run <id>', 'a specific run (defaults to the latest)')
    .option('--json', 'machine-readable output')
    .description('observe the adaptive kernel: phase, capabilities, cadence, cache savings')
    .action(async (opts: { run?: string; json?: boolean }) => {
      setExit(await kernelStatus(io, opts));
    });
};
