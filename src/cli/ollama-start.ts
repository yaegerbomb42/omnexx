import { UsageError } from '../errors.js';
import { hasProvider } from '../tui/chat.js';
import { println, readLine, type CliIO } from './io.js';
import { useOllama } from './ollama.js';
import { pullOllamaModel, setupOllama, type PullProgress } from './ollama-setup.js';

const PERCENT_STEP = 10;

/** Prints pull progress every PERCENT_STEP percent, and each new status once. */
export function progressPrinter(out: NodeJS.WritableStream): (p: PullProgress) => void {
  let lastStatus = '';
  let lastPercent = -PERCENT_STEP;
  return ({ status, percent }) => {
    if (percent !== undefined) {
      if (percent - lastPercent < PERCENT_STEP && percent !== 100) return;
      lastPercent = percent;
      out.write(`  ${status} ${percent}%\n`);
      return;
    }
    if (status === lastStatus) return;
    lastStatus = status;
    out.write(`  ${status}\n`);
  };
}

/**
 * `omnexx --ollama [model]`: the model ref to use. With a model named, that model; otherwise the
 * best tool-capable one, tuned and (when nothing else is configured) saved for every role. Offers
 * to pull a model on a terminal when none fits; says how to install Ollama when it isn't running.
 */
export async function startWithOllama(io: CliIO, wanted?: string): Promise<string> {
  if (wanted) return useOllama(io, wanted);
  const saveRoles = !(await hasProvider(io).catch(() => true));
  const first = await setupOllama(io, { saveRoles });
  if (first.kind === 'down') throw new UsageError(first.line, 'then run `omnexx --ollama` again');
  if (first.kind === 'ready') {
    println(io.stderr, first.line);
    return first.ref;
  }
  if (!io.isTTY) throw new UsageError(first.line, 'then run `omnexx --ollama` again');
  println(io.stderr, first.line);
  const answer = await readLine(io, `pull ${first.pull.model} now? [Y/n] `);
  if (answer === undefined || /^n/i.test(answer.trim()))
    throw new UsageError('no tool-capable model in Ollama', `ollama pull ${first.pull.model}`);
  await pullOllamaModel(io, first.pull.model, progressPrinter(io.stderr));
  const after = await setupOllama(io, { saveRoles });
  if (after.kind !== 'ready') throw new UsageError(after.line, 'then run `omnexx --ollama` again');
  println(io.stderr, after.line);
  return after.ref;
}
