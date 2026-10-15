import type { LoopDeps } from '../agent/loop.js';
import { workingTreeHash } from '../git/repo.js';
import { runGates } from '../verify/gates.js';
import { SpeculativeChecks } from '../verify/speculative.js';
import type { PlanNode } from './plan.js';
import type { Run } from './run.js';
import { gateContext } from './think-loop-check.js';

/**
 * Background gate runs for a loop session under `[plan] speculative_checks`, or undefined when
 * off. Browser gates are left to the check itself: they start a server and a browser.
 */
export function speculativeChecks(run: Run, task: PlanNode): SpeculativeChecks | undefined {
  if (!run.config.plan.speculative_checks) return undefined;
  const gates = run.config.gates.filter((g) => g.kind !== 'browser');
  if (!gates.length) return undefined;
  let runs = 0;
  return new SpeculativeChecks({
    clock: run.clock,
    treeHash: () => workingTreeHash(run.worktree, run.state.lastGreen),
    run: (signal) =>
      runGates(gates, {
        ...gateContext(run, `c${run.state.cycle}-spec${++runs}`),
        // Cancelled by a newer edit, or by the run itself stopping.
        signal: AbortSignal.any([signal, run.signal]),
      }),
    emit: (type, data) => {
      run.events.emit(type, { task: task.id, ...data });
    },
  });
}

/** Loop deps whose successful edits also (re)start the speculative checks. */
export function withSpeculation(deps: LoopDeps, spec: SpeculativeChecks | undefined): LoopDeps {
  if (!spec) return deps;
  const onEdit = deps.toolCtx.onEdit;
  return {
    ...deps,
    toolCtx: {
      ...deps.toolCtx,
      onEdit: (path) => {
        onEdit?.(path);
        spec.touch();
      },
    },
  };
}
