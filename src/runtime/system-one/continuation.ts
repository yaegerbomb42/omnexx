/** Gate 2: notice when the request is already done and the loop is only re-inspecting. */
import type { SystemOneClient } from './client.js';
import type { SystemOneBackendKind } from './types.js';

export const DONE_QUESTION = 'Has the core user request been fully resolved by the actions taken?';

const VERIFY = [
  /\b(?:vitest|jest|pytest|mocha|tsc|eslint)\b/,
  /\bprettier\s+--check\b/,
  /\bcargo\s+(?:test|check|clippy)\b/,
  /\bgo\s+(?:test|vet)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build|format:check)\b/,
];
const INSPECT =
  /^\s*(?:ls|cat|head|tail|wc|pwd|tree|find|stat|git\s+(?:status|diff|log|show|branch)|rg|grep)\b/;

export interface TurnCall {
  name: string;
  input: unknown;
  isError: boolean;
  readOnly: boolean;
}

const commandOf = (input: unknown): string => {
  const c = (input as { command?: unknown } | null)?.command;
  return typeof c === 'string' ? c : '';
};
const pathOf = (input: unknown): string | undefined => {
  const p = (input as { path?: unknown } | null)?.path;
  return typeof p === 'string' ? p : undefined;
};

type Kind = 'verify' | 'inspect' | 'mutate';

function kindOf(c: TurnCall): Kind {
  if (c.name === 'bash') {
    const cmd = commandOf(c.input);
    if (VERIFY.some((re) => re.test(cmd))) return 'verify';
    return INSPECT.test(cmd) ? 'inspect' : 'mutate';
  }
  return c.readOnly ? 'inspect' : 'mutate';
}

/** Follows the loop's trace: edits, verification results, and read-only churn after green. */
export class ContinuationTracker {
  readonly filesModified = new Set<string>();
  private green = false;
  private failed = false;
  private errorsLastTurn = false;
  redundantReadOnly = 0;
  readonly recentActions: string[] = [];

  record(calls: readonly TurnCall[], assistantSummary: string): void {
    this.errorsLastTurn = false;
    for (const c of calls) this.recordOne(c, assistantSummary);
  }

  private recordOne(c: TurnCall, summary: string): void {
    const kind = kindOf(c);
    const detail = c.name === 'bash' ? ': ' + commandOf(c.input).slice(0, 60) : '';
    this.recentActions.push(c.name + detail);
    if (this.recentActions.length > 8) this.recentActions.shift();
    if (kind === 'verify') this.recordVerify(c.isError);
    else if (c.isError) this.errorsLastTurn = true;
    else if (kind === 'mutate') this.recordMutation(c);
    else if (this.green || (this.filesModified.size === 0 && summary.length >= 200))
      this.redundantReadOnly++;
  }

  private recordVerify(failed: boolean): void {
    if (failed) {
      this.failed = true;
      this.green = false;
      this.redundantReadOnly = 0;
      return;
    }
    if (this.green) this.redundantReadOnly++;
    this.green = true;
    this.failed = false;
  }

  private recordMutation(c: TurnCall): void {
    const p = pathOf(c.input);
    if (p) this.filesModified.add(p);
    else if (c.name === 'bash') this.filesModified.add('(shell)');
    this.green = false;
    this.failed = false;
    this.redundantReadOnly = 0;
  }

  /** Only ask System-1 once the work is verified (or answered) and the loop is re-inspecting. */
  eligible(assistantSummary: string): boolean {
    if (this.failed || this.errorsLastTurn || this.redundantReadOnly < 2) return false;
    return this.filesModified.size > 0 ? this.green : assistantSummary.length >= 200;
  }

  state(prompt: string, assistantSummary: string): Record<string, unknown> {
    return {
      prompt: prompt.slice(0, 2_000),
      filesModified: [...this.filesModified].sort((a, b) => a.localeCompare(b)),
      testsPassed: this.green,
      testsFailed: this.failed,
      redundantReadOnly: this.redundantReadOnly,
      pendingCalls: 0,
      recentActions: [...this.recentActions],
      assistantSummary: assistantSummary.slice(0, 2_000),
    };
  }
}

export interface ContinuationVerdict {
  prob: number;
  stop: boolean;
  backend: SystemOneBackendKind;
  latencyMs: number;
}

export async function assessCompletion(
  client: SystemOneClient,
  state: Record<string, unknown>,
  threshold: number,
): Promise<ContinuationVerdict> {
  const r = await client.noul({ gate: 'continuation', state, question: DONE_QUESTION });
  return { prob: r.prob, stop: r.prob > threshold, backend: r.backend, latencyMs: r.latencyMs };
}
