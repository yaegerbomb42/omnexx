import type { OmnexxConfig } from '../config/schema.js';
import type { PlanNode } from '../core/plan.js';
import type { FileChange } from '../git/repo.js';
import { blobAt, hashWorkingFile } from '../git/repo.js';

export type StuckSignal =
  'consecutive_rejections' | 'repeated_signature' | 'task_cycles' | 'oscillation' | InCycleSignal;

/** Signals the agent loop raises mid-cycle (plan §3.10); each ends the cycle early. */
export const IN_CYCLE_SIGNALS = ['repeated_tool_call', 'no_edits', 'token_burn'] as const;
export type InCycleSignal = (typeof IN_CYCLE_SIGNALS)[number];

export function isInCycleSignal(s: string): s is InCycleSignal {
  return (IN_CYCLE_SIGNALS as readonly string[]).includes(s);
}

export interface InCycleLimits {
  repeatedToolCall: number;
  noEditTurns: number;
  /** Absolute token threshold for burn, or undefined until there's enough cycle history. */
  burnTokens: number | undefined;
}

/**
 * Tracks one cycle's tool calls and edits. `afterTurn` returns a finding once a limit is hit.
 */
export class InCycleWatch {
  private readonly calls = new Map<string, number>();
  private lastEditTurn = 0;
  private lastEdits = 0;

  constructor(
    private readonly limits: InCycleLimits,
    private readonly editCount: () => number,
  ) {}

  afterTurn(
    turn: number,
    cycleTokens: number,
    calls: readonly { name: string; input: unknown }[],
  ): (StuckFinding & { signal: InCycleSignal }) | undefined {
    const edits = this.editCount();
    if (edits > this.lastEdits) {
      this.lastEdits = edits;
      this.lastEditTurn = turn;
    }
    for (const c of calls) {
      const key = `${c.name} ${JSON.stringify(c.input)}`;
      const n = (this.calls.get(key) ?? 0) + 1;
      this.calls.set(key, n);
      if (n >= this.limits.repeatedToolCall)
        return {
          signal: 'repeated_tool_call',
          detail: `called ${c.name} with the same arguments ${n} times: ${key.slice(0, 200)}`,
        };
    }
    if (turn - this.lastEditTurn >= this.limits.noEditTurns)
      return {
        signal: 'no_edits',
        detail: `${turn - this.lastEditTurn} turns without editing a file`,
      };
    const burn = this.limits.burnTokens;
    if (burn !== undefined && edits === 0 && cycleTokens > burn)
      return {
        signal: 'token_burn',
        detail: `${cycleTokens} tokens with no edit, over the ${burn}-token burn limit`,
      };
    return undefined;
  }
}

/** Burn threshold from earlier cycles' token totals; needs at least 3 of them. */
export function burnThreshold(history: readonly number[], factor: number): number | undefined {
  if (history.length < 3) return undefined;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(median * factor);
}

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
  const onRung = task.attempts - task.rungStartedAt;
  if (onRung >= stuck.max_task_cycles && task.status !== 'done') {
    out.push({ signal: 'task_cycles', detail: `${onRung} cycles without finishing` });
  }
  return out;
}
