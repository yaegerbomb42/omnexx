/**
 * Formal planner/executor contract: the planner emits a single active `PlanArtifact`,
 * and the executor only accepts edits that touch files listed in its `fileTargets`.
 */

export interface PlanArtifact {
  steps: string[];
  risks: string[];
  fileTargets: string[];
  acceptanceCriteria: string[];
}

let activePlan: PlanArtifact | null = null;

/** Record `plan` as the session's single active plan. Throws if one is already active. */
export function emitPlan(plan: PlanArtifact): void {
  if (activePlan !== null) {
    throw new Error('a plan is already active; close it before emitting a new one');
  }
  activePlan = plan;
}

/**
 * Validate an edit against the active plan's `fileTargets`. Throws when there is no
 * active plan or when `filePath` is not among the targets.
 */
export function validateEdit(filePath: string): void {
  if (activePlan === null) {
    throw new Error('no active plan to validate the edit against');
  }
  if (!activePlan.fileTargets.includes(filePath)) {
    throw new Error(`edit targets ${filePath}, which is not in the active plan's fileTargets`);
  }
}

/** Clear the active plan so a new one can be emitted. */
export function closePlan(): void {
  activePlan = null;
}
