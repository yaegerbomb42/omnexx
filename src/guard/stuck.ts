import type { OmnexxConfig } from '../config/schema.js';
import type { PlanNode } from '../core/plan.js';
import type { FileChange } from '../git/repo.js';
import { blobAt, hashWorkingFile } from '../git/repo.js';

export type StuckSignal =
  'consecutive_rejections' | 'repeated_signature' | 'task_cycles' | 'oscillation';

export interface StuckFinding {
  signal: StuckSignal;
  detail: string;
}

/**
 * A→B→A detection by content hash (plan §3.10): the candidate puts every file it changes back
 * to the exact blob it had at an earlier green commit, undoing what was accepted since then.
 */
export async function detectOscillation(
  cwd: string,
  lastGreen: string,
  earlierGreens: readonly string[],
  changes: readonly FileChange[],
): Promise<StuckFinding | undefined> {
  if (!changes.length) return undefined;
  const now = new Map<string, string | undefined>();
  const atLast = new Map<string, string | undefined>();
  for (const c of changes) {
    now.set(c.path, c.status === 'D' ? undefined : await hashWorkingFile(cwd, c.path));
    atLast.set(c.path, await blobAt(cwd, lastGreen, c.path));
  }
  for (const g of earlierGreens) {
    if (g === lastGreen) continue;
    let reverts = true;
    for (const c of changes) {
      const then = await blobAt(cwd, g, c.path);
      if (then !== now.get(c.path) || then === atLast.get(c.path)) {
        reverts = false;
        break;
      }
    }
    if (reverts) {
      return {
        signal: 'oscillation',
        detail: `diff restores ${changes.map((c) => c.path).join(', ')} to their content at ${g.slice(0, 10)}, undoing accepted work`,
      };
    }
  }
  return undefined;
}

/** Signals over one task's history, evaluated after RECORD. */
export function taskStuckSignals(task: PlanNode, stuck: OmnexxConfig['stuck']): StuckFinding[] {
  const out: StuckFinding[] = [];
  if (task.consecutiveRejections >= stuck.max_consecutive_rejections) {
    out.push({
      signal: 'consecutive_rejections',
      detail: `${task.consecutiveRejections} rejections in a row`,
    });
  }
  const last = task.failureSignatures.at(-1);
  if (last) {
    const same = task.failureSignatures.filter((s) => s === last).length;
    if (same >= stuck.max_same_signature)
      out.push({ signal: 'repeated_signature', detail: `same failure ${same} times` });
  }
  if (task.attempts >= stuck.max_task_cycles && task.status !== 'done') {
    out.push({ signal: 'task_cycles', detail: `${task.attempts} cycles without finishing` });
  }
  return out;
}
