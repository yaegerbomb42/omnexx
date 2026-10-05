import { MAX_STATE_BYTES } from './types.js';

/** The compact agent-state summary for the next-move decision (plan §13). Deterministic key order. */
export interface AgentStateSummary {
  goal: string;
  task: { id: string; title: string; acceptance: string[]; attempts: number };
  lastResult: {
    outcome: 'accepted' | 'rejected' | 'none';
    passed: number;
    failed: number;
    topFailures: string[];
  };
  recentSignatures: string[];
  diff: { files: number; added: number; removed: number };
  approachesTried: string[];
  budgetLeft: { usd: number; cycles: number; hours: number };
  notes?: string[];
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Fit the summary under `maxBytes` deterministically: first drop optional whole fields, then
 * shorten long strings, then drop list items from the oldest end, then trim the goal.
 */
export function fitSummary(
  input: AgentStateSummary,
  maxBytes = MAX_STATE_BYTES,
): AgentStateSummary {
  const s: AgentStateSummary = structuredClone(input);
  s.goal = clipText(s.goal, 2_000);
  s.task.title = clipText(s.task.title, 200);
  s.task.acceptance = s.task.acceptance.map((a) => clipText(a, 300));
  s.lastResult.topFailures = s.lastResult.topFailures.map((f) => clipText(f, 400));
  s.recentSignatures = s.recentSignatures.map((f) => clipText(f, 300));
  s.approachesTried = s.approachesTried.map((a) => clipText(a, 300));
  if (bytes(s) <= maxBytes) return s;
  delete s.notes;
  const lists: (() => string[])[] = [
    () => s.recentSignatures,
    () => s.approachesTried,
    () => s.lastResult.topFailures,
    () => s.task.acceptance,
  ];
  // Track the size incrementally: re-serialising after every shift is quadratic on huge inputs.
  let size = bytes(s);
  const itemBytes = (x: string): number => Buffer.byteLength(JSON.stringify(x)) + 1;
  for (const keep of [1, 0]) {
    for (const list of lists) {
      const arr = list();
      while (size > maxBytes && arr.length > keep) size -= itemBytes(arr.shift() ?? '');
    }
  }
  size = bytes(s);
  while (size > maxBytes && s.goal.length > 100) {
    s.goal = `${s.goal.slice(0, Math.floor(s.goal.length / 2))}…`;
    size = bytes(s);
  }
  return s;
}
