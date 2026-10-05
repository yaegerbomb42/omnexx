import type { Command } from 'commander';
import { resolvePaths } from '../../core/paths.js';
import { UsageError } from '../../errors.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import { pickRun } from './control.js';

export const STEERING_HEADING = '## Steering';

/** Append a dated note under "## Steering" in goal.md; the run picks it up at the next cycle. */
export async function steerRun(
  io: CliIO,
  runId: string | undefined,
  text: string,
  now = Date.now(),
): Promise<string> {
  const note = text.trim();
  if (!note) throw new UsageError('nothing to steer with', 'omnexx steer "focus on the API first"');
  const store = await pickRun(resolvePaths(io.env), runId);
  const goal = (await store.readGoal()).text.trimEnd();
  const stamp = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
  const head = goal.includes(STEERING_HEADING) ? goal : `${goal}\n\n${STEERING_HEADING}`;
  await store.writeGoal(`${head}\n- ${stamp}: ${note}\n`);
  return store.runId;
}

export function register(program: Command, io: CliIO, setExit: (code: number) => void): void {
  program
    .command('steer')
    .argument('<text...>', 'the note, e.g. "skip the admin UI, focus on the API"')
    .option('--run <runId>', 'defaults to the most recent run')
    .description('add a steering note to a run’s goal; picked up at the next cycle')
    .action(async (words: string[], opts: { run?: string }) => {
      const id = await steerRun(io, opts.run, words.join(' '));
      println(io.stdout, `steering note added to ${id}; it applies from the next cycle`);
      setExit(EXIT.ok);
    });
}
