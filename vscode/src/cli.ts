import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { engine } from './engine.js';
import {
  parseChats,
  parsePlan,
  parseRuns,
  type ChatRow,
  type PlanView,
  type RunRow,
} from './model.js';

const CALL_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RUN_ID = /^r_[A-Za-z0-9_-]+$/;

export function checkRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`not a run id: ${runId}`);
  return runId;
}

/** Run one short omnexx command and return its stdout. Rejects with omnexx's own message. */
async function call(args: readonly string[], cwd: string | undefined): Promise<string> {
  const e = await engine();
  return new Promise((resolve, reject) => {
    execFile(
      e.command,
      [...e.prefix, ...args],
      // A global npm install on Windows is a .cmd shim, which only runs through a shell.
      // Every argument here is a fixed word or a checked run id.
      { cwd, env: e.env, timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, shell: e.shell },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          reject(
            new Error('omnexx is not installed or not on PATH (see the omnexx.path setting).'),
          );
          return;
        }
        reject(new Error(stderr.trim() || err.message));
      },
    );
  });
}

export async function listRuns(cwd: string | undefined): Promise<RunRow[]> {
  return parseRuns(await call(['runs', '--json'], cwd));
}

/** Saved chats in this folder; an older omnexx without `chats` lists none. */
export async function listChats(cwd: string | undefined): Promise<ChatRow[]> {
  try {
    return parseChats(await call(['chats', '--json'], cwd));
  } catch (err) {
    if (err instanceof Error && /unknown command/i.test(err.message)) return [];
    throw err;
  }
}

export async function readPlan(runId: string, cwd: string | undefined): Promise<PlanView> {
  return parsePlan(await call(['plan', checkRunId(runId), '--json'], cwd));
}

export type Control = 'pause' | 'resume' | 'stop';

export async function control(
  action: Control,
  runId: string,
  cwd: string | undefined,
): Promise<string> {
  return (await call([action, checkRunId(runId)], cwd)).trim();
}

/** Open a terminal that runs omnexx directly (no shell, so the goal needs no quoting). */
export async function openTerminal(
  name: string,
  args: string[],
  cwd: string | undefined,
): Promise<void> {
  const e = await engine();
  const terminal = vscode.window.createTerminal({
    name,
    shellPath: e.command,
    shellArgs: [...e.prefix, ...args],
    env: e.source === 'bundled' ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    ...(cwd ? { cwd } : {}),
  });
  terminal.show();
}
