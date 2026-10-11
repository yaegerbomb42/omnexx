import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { parsePlan, parseRuns, type PlanView, type RunRow } from './model.js';

const CALL_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RUN_ID = /^r_[A-Za-z0-9_-]+$/;
const isWindows = process.platform === 'win32';

/** The omnexx executable: the `omnexx.path` setting, else `omnexx` on PATH. */
export function omnexxBin(): string {
  const configured = vscode.workspace.getConfiguration('omnexx').get<string>('path')?.trim();
  if (configured) return configured;
  return isWindows ? 'omnexx.cmd' : 'omnexx';
}

export function checkRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`not a run id: ${runId}`);
  return runId;
}

/** Run one short omnexx command and return its stdout. Rejects with omnexx's own message. */
function call(args: readonly string[], cwd: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      omnexxBin(),
      args,
      // npm installs omnexx as a .cmd shim on Windows, which only runs through a shell.
      // Every argument here is a fixed word or a checked run id.
      { cwd, timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, shell: isWindows },
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
export function openTerminal(name: string, args: string[], cwd: string | undefined): void {
  const terminal = vscode.window.createTerminal({
    name,
    shellPath: omnexxBin(),
    shellArgs: args,
    ...(cwd ? { cwd } : {}),
  });
  terminal.show();
}
