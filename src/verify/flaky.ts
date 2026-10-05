import type { GateConfig } from '../config/schema.js';
import type { Baseline } from '../core/run-store.js';
import { runGate, type GateResult, type GateRunContext } from './gates.js';
import { judgeGate } from './ratchet.js';

export interface FlakyFinding {
  gate: string;
  ids: string[];
}

/**
 * Run each gate; when one shows new failures that the parser could name, run the whole gate
 * again (up to `flaky_reruns` times). Ids that failed new and then passed are flaky: the verdict
 * is taken from the last run, so they don't count as a regression, but they are reported. A
 * failure that persists, or a different new one on the re-run, still fails the gate.
 */
export async function runGatesWithFlakyCheck(
  gates: readonly GateConfig[],
  ctx: GateRunContext,
  baseline: Baseline | undefined,
): Promise<{ results: GateResult[]; flaky: FlakyFinding[] }> {
  const results: GateResult[] = [];
  const flaky: FlakyFinding[] = [];
  for (const gate of gates) {
    let result = await runGate(gate, ctx);
    const seen = new Set<string>();
    for (let i = 1; i <= gate.flaky_reruns; i++) {
      const v = judgeGate(result, baseline);
      if (v.pass || result.timedOut || !result.structured || !v.newFailures.length) break;
      for (const id of v.newFailures) seen.add(id);
      result = await runGate(gate, { ...ctx, label: `${ctx.label}-rerun${i}` });
    }
    const still = new Set(result.failures.map((f) => f.id));
    const ids = [...seen].filter((id) => !still.has(id));
    if (ids.length) flaky.push({ gate: gate.name, ids });
    results.push(result);
  }
  return { results, flaky };
}
