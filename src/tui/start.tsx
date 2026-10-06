import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from 'ink';
import type { CliIO } from '../cli/io.js';
import { resolvePaths } from '../core/paths.js';
import { checkForUpdate } from '../cli/update-check.js';
import { App } from './app.js';
import { Session, type RunCli } from './session.js';

interface TuiState {
  seenWhy?: boolean;
}

async function readState(file: string): Promise<TuiState> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as TuiState;
  } catch {
    return {};
  }
}

/** The interactive session: bare `omnexx` on a terminal, or `omnexx watch [runId]`. */
export async function startTui(
  io: CliIO,
  runCli: RunCli,
  opts: { version: string; attach?: string | true },
): Promise<number> {
  const paths = resolvePaths(io.env);
  const stateFile = join(paths.configHome, 'tui.json');
  const state = await readState(stateFile);
  const session = new Session(io, runCli);
  if (opts.attach === true) await session.attach();
  else if (opts.attach) await session.attach(opts.attach);
  else await session.resumeLatest();
  await session.greet();
  // Fire and forget: a slow or offline registry never delays the session.
  void checkForUpdate({
    current: opts.version,
    cacheFile: join(paths.configHome, 'update-check.json'),
    env: io.env,
  }).then((latest) => {
    if (latest)
      session.push('system', `omnexx ${latest} is out (you have ${opts.version}): npm i -g omnexx`);
  });
  const app = render(
    <App session={session} version={opts.version} cwd={io.cwd} showWhy={!state.seenWhy} />,
    { exitOnCtrlC: false },
  );
  if (!state.seenWhy) {
    await mkdir(paths.configHome, { recursive: true });
    await writeFile(stateFile, JSON.stringify({ ...state, seenWhy: true }));
  }
  await app.waitUntilExit();
  if (session.runId && session.runAlive) {
    io.stdout.write(`${session.runId} keeps running. \`omnexx watch\` to return.\n`);
  }
  return 0;
}
