import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';
import { PROJECT_CONFIG } from '../../config/load.js';
import { UsageError } from '../../errors.js';
import { git } from '../../git/git.js';
import { detectProject, renderProjectToml } from '../detect.js';
import { confirm, println, type CliIO } from '../io.js';

export interface InitOptions {
  yes?: boolean;
}

export type InitOutcome = 'written' | 'unchanged' | 'exists' | 'declined';

export async function runInit(io: CliIO, opts: InitOptions): Promise<InitOutcome> {
  const root = io.cwd;
  try {
    await git(root, ['rev-parse', '--git-dir']);
  } catch {
    throw new UsageError(
      `${root} is not a git repository`,
      'run `git init` first, or cd into a repo',
    );
  }

  const detection = await detectProject(root);
  const content = renderProjectToml(detection);
  const target = join(root, PROJECT_CONFIG);

  println(io.stdout, pc.bold('Detected'));
  println(io.stdout, `  language:        ${detection.language}`);
  println(io.stdout, `  package manager: ${detection.packageManager ?? '-'}`);
  println(io.stdout, `  setup:           ${detection.setup.join(' && ') || '-'}`);
  if (detection.gates.length === 0)
    println(io.stdout, `  gates:           ${pc.yellow('none found')}`);
  for (const g of detection.gates) {
    println(io.stdout, `  gate ${g.name.padEnd(10)} ${g.run}  (${g.level}, parser ${g.parser})`);
  }

  let existing: string | undefined;
  try {
    await access(target);
    existing = await readFile(target, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    if (existing === content) {
      println(io.stdout, `${PROJECT_CONFIG} is already up to date.`);
      return 'unchanged';
    }
    println(io.stdout, `${PROJECT_CONFIG} already exists; leaving it unchanged.`);
    return 'exists';
  }

  println(io.stdout);
  println(io.stdout, content);
  if (!opts.yes && !(await confirm(io, `Write ${PROJECT_CONFIG}?`))) {
    println(io.stdout, 'Nothing written.');
    return 'declined';
  }
  await writeFile(target, content);
  println(
    io.stdout,
    `Wrote ${PROJECT_CONFIG}. Next: \`omnexx doctor\`, then \`omnexx run "<goal>"\`.`,
  );
  return 'written';
}
