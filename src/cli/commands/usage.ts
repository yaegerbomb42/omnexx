import pc from 'picocolors';
import { resolvePaths, usageFile } from '../../core/paths.js';
import { UsageError } from '../../errors.js';
import { readUsageLedger, summarizeUsage, type UsageReport } from '../../providers/usage-ledger.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';

const fmt = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
};

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function table(io: CliIO, report: UsageReport): void {
  const rows = Object.entries(report.byPurpose).sort((a, b) => b[1].usd - a[1].usd);
  const head = `${'purpose'.padEnd(14)} ${'calls'.padStart(6)} ${'input'.padStart(9)} ${'output'.padStart(8)} ${'usd'.padStart(10)} ${'share'.padStart(7)}`;
  println(io.stdout, pc.bold(head));
  for (const [purpose, p] of rows)
    println(
      io.stdout,
      `${purpose.padEnd(14)} ${String(p.calls).padStart(6)} ${fmt(p.inputTokens).padStart(9)} ${fmt(p.outputTokens).padStart(8)} ${`$${p.usd.toFixed(4)}`.padStart(10)} ${pct(p.share).padStart(7)}`,
    );
  if (!rows.length) println(io.stdout, '  (no model calls recorded yet)');
}

function wasteSection(io: CliIO, report: UsageReport): void {
  const w = report.waste;
  println(io.stdout, '');
  println(io.stdout, pc.bold('Waste'));
  println(
    io.stdout,
    `  repeat reads of unchanged files: ${String(w.repeatRead.events)} events, ${fmt(w.repeatRead.tokensSaved)} tokens saved${w.repeatRead.files ? ` (${String(w.repeatRead.files)} files)` : ''}`,
  );
  println(
    io.stdout,
    `  retries with the same error:    ${String(w.retries.events)} events, ${fmt(w.retries.tokens)} input tokens re-sent${w.retries.signatures ? ` (${String(w.retries.signatures)} signatures)` : ''}`,
  );
  println(
    io.stdout,
    `  compactions that did not shrink: ${String(w.compactions.events)} events, ${fmt(w.compactions.tokens)} tokens left behind`,
  );
  println(
    io.stdout,
    `  context re-sent across turns:   ${fmt(w.contextResend.tokens)} tokens (${fmt(w.contextResend.cached)} were cache reads, ${String(w.contextResend.turns)} turns)`,
  );
  println(
    io.stdout,
    `  ${pc.dim('net explainable waste:')} ${pc.bold(fmt(Math.max(0, w.totalTokens - w.repeatRead.tokensSaved)))} tokens; ${pc.green(`${fmt(w.repeatRead.tokensSaved)} avoided`)} by the re-read guard`,
  );
}

function stepsSection(io: CliIO, report: UsageReport): void {
  if (!report.byStep.length) return;
  println(io.stdout, '');
  println(io.stdout, pc.bold('Top steps'));
  for (const s of report.byStep.slice(0, 8))
    println(
      io.stdout,
      `  ${s.step.padEnd(18)} ${String(s.calls).padStart(4)} calls  ${fmt(s.tokens).padStart(8)} tokens  $${s.usd.toFixed(4)}`,
    );
}

function render(io: CliIO, report: UsageReport): void {
  const title = report.labels.length ? report.labels.join(', ') : report.query || 'all tasks';
  println(io.stdout, pc.bold(`Usage: ${title}`));
  const when =
    report.firstAt !== undefined && report.lastAt !== undefined
      ? ` · ${new Date(report.firstAt).toISOString().slice(0, 16)} → ${new Date(report.lastAt).toISOString().slice(0, 16)}`
      : '';
  println(
    io.stdout,
    `  ${String(report.calls)} calls · $${report.usd.toFixed(4)} · input ${fmt(report.inputTokens)} (${fmt(report.cacheRead)} cached) · output ${fmt(report.outputTokens)}${when}`,
  );
  if (report.runs.length && report.runs.length <= 3)
    println(io.stdout, pc.dim(`  runs: ${report.runs.join(', ')}`));
  println(io.stdout, '');
  table(io, report);
  if (Object.keys(report.byTask).length > 1) {
    println(io.stdout, '');
    println(io.stdout, pc.bold('By task'));
    for (const [task, t] of Object.entries(report.byTask).sort((a, b) => b[1].usd - a[1].usd))
      println(
        io.stdout,
        `  ${task.padEnd(22)} ${String(t.calls).padStart(4)} calls  ${fmt(t.tokens).padStart(8)} tokens  $${t.usd.toFixed(4)}`,
      );
  }
  stepsSection(io, report);
  wasteSection(io, report);
  println(io.stdout, '');
  println(
    io.stdout,
    report.attribution.untagged
      ? pc.red(
          `Attribution: ${pct(report.attribution.share)} (${String(report.attribution.untagged)} of ${String(report.calls)} calls untagged)`,
        )
      : pc.green(
          `Attribution: ${pct(report.attribution.share)} (${String(report.attribution.tagged)}/${String(report.calls)} calls tagged)`,
        ),
  );
}

export const register: CommandRegistrar = (program, io, setExit) => {
  program
    .command('usage')
    .argument('[task]', 'task id, bench label, or run id (defaults to the whole ledger)')
    .option('--json', 'machine-readable output')
    .option('--list', 'list tasks in the ledger')
    .description('where every token went, by purpose, task and step, plus wasted spend')
    .action((task: string | undefined, opts: { json?: boolean; list?: boolean }) => {
      const file = usageFile(resolvePaths(io.env));
      const records = readUsageLedger(file);
      if (!records.length) {
        println(io.stdout, `No usage recorded yet (${file}).`);
        setExit(EXIT.ok);
        return;
      }
      if (opts.list) {
        const labels = new Map<string, number>();
        for (const r of records)
          if (r.kind === 'call') labels.set(r.label, (labels.get(r.label) ?? 0) + 1);
        for (const [label, calls] of [...labels.entries()].sort())
          println(io.stdout, `${label}  ${String(calls)} calls`);
        setExit(EXIT.ok);
        return;
      }
      const report = summarizeUsage(records, task ?? '');
      if (task && !report.calls && !report.waste.repeatRead.events) {
        throw new UsageError(
          `no usage for "${task}"`,
          `run \`omnexx usage --list\` to see the labels in ${file}`,
        );
      }
      if (opts.json) println(io.stdout, JSON.stringify(report, null, 2));
      else render(io, report);
      setExit(EXIT.ok);
    });
};
