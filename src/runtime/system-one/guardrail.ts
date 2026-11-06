/** Gate 1: pre-flight check of a shell command for destructive or out-of-scope mutations. */
import type { SystemOneClient } from './client.js';
import { destructiveProb } from './features.js';
import type { SystemOneBackendKind } from './types.js';

export const DESTRUCTIVE_QUESTION =
  'Does this bash command perform a destructive, unrecoverable, or out-of-scope mutation?';

export const DESTRUCTIVE_CRITERIA = {
  true: 'Force-pushes, hard-resets git history, recursively deletes tracked or outside-repo paths, clobbers uncommitted work, drops databases/tables, wipes env/credentials, pipes untrusted remote scripts to sh, or mutates paths outside cwd',
  false:
    'Standard read/search/build/test/lint commands, reversible local edits, git status/diff/log/branch, or scoped project commands',
};

export interface GuardrailInput {
  command: string;
  cwd: string;
  repoRoot: string;
  allowOutsideRepo: boolean;
}

export interface GuardrailVerdict {
  prob: number;
  destructive: boolean;
  backend: SystemOneBackendKind;
  latencyMs: number;
}

export async function assessCommand(
  client: SystemOneClient,
  input: GuardrailInput,
  threshold: number,
): Promise<GuardrailVerdict> {
  const r = await client.noul({
    gate: 'guardrail',
    state: { ...input },
    question: DESTRUCTIVE_QUESTION,
    criteria: DESTRUCTIVE_CRITERIA,
  });
  // The calibrated features are a floor: a remote model can't talk the gate out of `rm -rf /`.
  const floor = destructiveProb(input.command, input.cwd, input.repoRoot, input.allowOutsideRepo);
  const prob = Math.max(r.prob, floor);
  return { prob, destructive: prob > threshold, backend: r.backend, latencyMs: r.latencyMs };
}

export const commandPreview = (command: string): string =>
  command.length > 120 ? `${command.slice(0, 117)}...` : command;

export function blockedByUser(prob: number): string {
  return `[system1:guardrail] Command blocked by user confirmation (destructive prob=${prob.toFixed(2)}). Take a safe, reversible alternative or ask the user how to proceed.`;
}

export function blockedUnattended(prob: number): string {
  return `[system1:guardrail] Command blocked: it looks destructive, unrecoverable, or out of scope (prob=${prob.toFixed(2)}) and no one is here to approve it. Use a reversible alternative (git stash, a new branch, a scoped path, a dry run) instead.`;
}
