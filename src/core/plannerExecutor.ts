/**
 * Formal planner/executor contract.
 *
 * A planner emits a single active {@link PlanArtifact}; the executor only accepts edits
 * that touch files listed in its `fileTargets`. Each {@link PlannerExecutor} instance
 * owns its own active plan, so concurrent sessions must each create their own instance
 * rather than share one.
 */

import { realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';

/** A plan produced by a planner and enforced by the executor. */
export interface PlanArtifact {
  /** High-level steps the agent intends to take. */
  steps: string[];
  /** Known or anticipated risks, for review before execution. */
  risks: string[];
  /**
   * Files the executor may edit, relative to the repository root. Paths are exact —
   * no glob patterns — and are matched after resolving symlinks and normalizing
   * `./`, `..`, absolute vs. relative spelling, trailing separators, and (on Windows)
   * case. Because matching is by canonical real path, plans should list real file paths
   * rather than symlinks.
   */
  fileTargets: string[];
  /** Criteria the finished work must satisfy. */
  acceptanceCriteria: string[];
}

const ERROR_NO_ACTIVE_PLAN = 'no active plan to validate the edit against';
const ERROR_PLAN_ALREADY_ACTIVE = 'a plan is already active; close it before emitting a new one';

/**
 * Canonicalize a path for comparison: resolve symlinks when the file exists (so
 * aliases and the real file behind a symlink compare equal), otherwise fall back to
 * lexical normalization for files that do not exist yet.
 */
function canonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(normalize(filePath));
  }
}

/** Compare two canonical paths, case-insensitively on Windows. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Owns the single active plan for one session. Create one instance per session;
 * instances are fully independent.
 */
export class PlannerExecutor {
  private activePlan: PlanArtifact | null = null;

  /** Record `plan` as this executor's active plan. Throws if one is already active. */
  emitPlan(plan: PlanArtifact): void {
    if (this.activePlan !== null) {
      throw new Error(ERROR_PLAN_ALREADY_ACTIVE);
    }
    this.activePlan = plan;
  }

  /**
   * Validate an edit against the active plan's `fileTargets`. Throws when there is no
   * active plan or when `filePath` does not canonicalize to one of the targets.
   */
  validateEdit(filePath: string): void {
    if (this.activePlan === null) {
      throw new Error(ERROR_NO_ACTIVE_PLAN);
    }
    const editPath = canonicalPath(filePath);
    const isTarget = this.activePlan.fileTargets.some((target) =>
      samePath(editPath, canonicalPath(target)),
    );
    if (!isTarget) {
      throw new Error(
        `edit targets ${filePath}, which is not included in the active plan's fileTargets`,
      );
    }
  }

  /** Clear the active plan so a new one can be emitted. */
  closePlan(): void {
    this.activePlan = null;
  }
}
