import { readFile } from 'node:fs/promises';
import pc from 'picocolors';
import { resolvePaths } from '../../core/paths.js';
import { UsageError } from '../../errors.js';
import { parseLedger, type LedgerRecord } from '../../usage/ledger.js';
import { aggregateUsage, fmtTokens, fmtUsd, pct, type UsageBreakdown } from '../../usage/report.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import { pickRun } from './control.js';

export interface UsageCommandOptions {
  run?: string;
  json?: boolean;
}

function printBreakdown(io: CliIO, d: UsageBreakdown, task: string | undefined): void {
  const title = task
    ? `task ${task}`
    : `${d.taskIds.length} task${d.taskIds.length === 1 ? '' : 's'}`;
  println(
    io.stdout,
    pc.bold(`${title} · ${d.calls} calls · ${fmtTokens(d.tokens.total)} tokens · ${fmtUsd(d.usd)}`),
  );
  println(
    io.stdout,
    `  input ${fmtTokens(d.tokens.input)} (cache reads ${fmtTokens(d.tokens.cacheRead)}) · output ${fmtTokens(d.tokens.output)} · budget-weighted ${fmtTokens(d.budgetTokens)}`,
  );

  println(io.stdout, '  by purpose');
  for (const r of d.byPurpose)
    println(
      io.stdout,
      `    ${r.purpose.padEnd(12)} ${String(r.calls).padStart(4)} calls  ${fmtTokens(r.tokens).padStart(7)}  ${pct(r.share).padStart(4)}  ${fmtUsd(r.usd)}`,
    );

  if (!task && d.byTask.length > 1) {
    println(io.stdout, '  by task');
    for (const r of d.byTask)
      println(
        io.stdout,
        `    ${r.taskId.padEnd(12)} ${String(r.calls).padStart(4)} calls  ${fmtTokens(r.tokens).padStart(7)}  ${fmtUsd(r.usd)}`,
      );
  }

  if (d.steps.length) {
    println(io.stdout, '  most expensive steps');
    for (const s of d.steps.slice(0, 5))
      println(
        io.stdout,
        `    ${`${s.taskId} step ${String(s.step)}`.padEnd(20)} ${String(s.calls).padStart(3)} calls  ${fmtTokens(s.tokens).padStart(7)}  ${fmtUsd(s.usd)}`,
      );
  }

  const w = d.waste;
  println(io.stdout, '  waste');
  println(
    io.stdout,
    `    repeat reads          ${String(w.repeatReads.count).padStart(4)}  ${fmtTokens(w.repeatReads.tokens)} tokens saved`,
  );
  for (const r of w.repeatReads.paths.slice(0, 5))
    println(io.stdout, `      ${r.path}  ×${r.count}  saved ${fmtTokens(r.tokens)}`);
  println(
    io.stdout,
    `    same-error retries    ${String(w.retries.calls).padStart(4)}  ${fmtTokens(w.retries.tokens)} tokens`,
  );
  for (const r of w.retries.signatures.slice(0, 3))
    println(io.stdout, `      ${r.signature.slice(0, 90)}  ×${r.calls}  ${fmtTokens(r.tokens)}`);
  println(
    io.stdout,
    `    non-shrinking folds   ${String(w.compactions.count).padStart(4)}  ${fmtTokens(w.compactions.tokens)} tokens`,
  );
  for (const detail of w.compactions.details.slice(0, 3))
    println(io.stdout, `      ${detail.slice(0, 100)}`);
  println(
    io.stdout,
    `    context re-sent       ${String(w.contextResent.calls).padStart(4)}  ${fmtTokens(w.contextResent.tokens)} tokens read from cache`,
  );
  println(
    io.stdout,
    `    avoidable             ${fmtTokens(w.avoidableTokens)} (${pct(
      d.tokens.total ? w.avoidableTokens / d.tokens.total : 0,
    )} of tokens)`,
  );
}

/**
 * `omnexx usage [task]`: where a run's tokens and dollars went, per purpose, model and step,
 * plus the waste the harness prevented or failed to prevent. Reads the run's ledger; a run from
 * before per-call attribution falls back to its state.json totals with a plain note.
 */
export async function usageCommand(
  io: CliIO,
  task: string | undefined,
  opts: UsageCommandOptions = {},
): Promise<number> {
  const store = await pickRun(resolvePaths(io.env), opts.run);
  let records: LedgerRecord[];
  try {
    records = parseLedger(await readFile(store.file('usage-ledger.jsonl'), 'utf8'));
  } catch {
    records = [];
  }

  if (!records.length) {
    const state = await store.readState();
    if (opts.json) {
      println(
        io.stdout,
        JSON.stringify(
          {
            runId: state.runId,
            ledger: false,
            taskId: task ?? null,
            usd: state.spend.usd,
            calls: state.spend.llmCalls,
            tokens: state.spend.tokens,
            note: 'this run predates the per-call usage ledger; totals come from state.json',
          },
          null,
          2,
        ),
      );
      return EXIT.ok;
    }
    println(io.stdout, `${state.runId} has no usage ledger (it predates per-call attribution).`);
    println(
      io.stdout,
      `  state.json totals: ${state.spend.llmCalls} calls · ${fmtUsd(state.spend.usd)} · ${fmtTokens(
        state.spend.tokens.uncached +
          state.spend.tokens.cacheWrite +
          state.spend.tokens.cacheRead +
          state.spend.tokens.output,
      )} tokens`,
    );
    return EXIT.ok;
  }

  const d = aggregateUsage(records, task ? { taskId: task } : {});
  if (task && !d.taskIds.includes(task)) {
    throw new UsageError(
      `no usage for task ${task} in ${store.runId}`,
      `tasks in the ledger: ${d.taskIds.join(', ') || '(none)'}`,
    );
  }
  if (opts.json) {
    println(
      io.stdout,
      JSON.stringify({ runId: store.runId, ledger: true, taskId: task ?? null, ...d }, null, 2),
    );
    return EXIT.ok;
  }
  printBreakdown(io, d, task);
  return EXIT.ok;
}
