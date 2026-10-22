/**
 * The hierarchical swarm: one coordinator, four specialized roles, a fixed pipeline. The
 * architect maps the goal into a structured milestone spec, the implementer writes the
 * minimal code that satisfies it, the red-team tries to break that code with aggressive
 * tests, and the auditor reviews the result against OWASP standards and project invariants.
 * Each phase's output lands on the shared scratchpad ('spec', 'impl', 'qa', 'audit'), so
 * later phases — and the owner, afterwards — read results instead of re-deriving them.
 *
 * The implementer is the only phase that can collide with parallel work, so the coordinator
 * holds region locks for every file region the spec names for the whole implementation
 * phase, and releases them in a finally: a crashed implementer must never wedge the tree.
 *
 * Orchestration only. This module makes no model or provider calls: each role's work is an
 * injected executor. Production wiring adapts helperRunner (./subagent.ts) to these
 * signatures, giving each role its brief (SWARM_ROLES) and its own model chain; tests inject
 * fakes. Keeping the model out of the coordinator is what makes the pipeline's ordering,
 * locking and verdict logic unit-testable at all.
 */
import type { FileRegion, RegionLockManager } from '../workers/file-locks.js';
import { wholeFileRegion } from '../workers/file-locks.js';
import type { SharedScratchpad } from '../workers/scratchpad.js';

export type SwarmRoleId = 'architect' | 'implementer' | 'red-team' | 'auditor';

/** What a role may do. Read-only roles get 'read' and nothing else; enforced at wiring time. */
export type SwarmCapability = 'read' | 'write-code' | 'write-tests' | 'lock-regions';

export interface SwarmRole {
  id: SwarmRoleId;
  title: string;
  /** System-prompt brief, in the voice of subagent.ts's BRIEF entries: terse and imperative. */
  brief: string;
  capabilities: readonly SwarmCapability[];
}

/** The four roles. Order here is pipeline order. */
export const SWARM_ROLES: Record<SwarmRoleId, SwarmRole> = {
  architect: {
    id: 'architect',
    title: 'Architect / Explorer',
    brief:
      'Map the call graph and dependencies for the goal, then write a structured milestone ' +
      'spec: the files, the regions within them, and the acceptance checks. Read-only: ' +
      'describe the shape of the change, never the code.',
    capabilities: ['read'],
  },
  implementer: {
    id: 'implementer',
    title: 'Implementer',
    brief:
      'Write the minimal code that satisfies the spec — nothing more. Hold region locks ' +
      'for every file you touch, match the surrounding style, and stop when the acceptance ' +
      'checks pass.',
    capabilities: ['read', 'write-code', 'lock-regions'],
  },
  'red-team': {
    id: 'red-team',
    title: 'Adversarial Red-Team / QA',
    brief:
      'Attack the implementation: fuzz it, probe the boundaries and the malformed inputs, ' +
      'and write tests designed to break it. A test that cannot fail proves nothing.',
    capabilities: ['read', 'write-tests'],
  },
  auditor: {
    id: 'auditor',
    title: 'Security & Quality Auditor',
    brief:
      'Review the diff against the OWASP standards and the project invariants. Report ' +
      'only findings you can evidence from the diff; block on security and correctness, ' +
      'never on taste.',
    capabilities: ['read'],
  },
};

/** One file the milestone touches; regions omitted means the whole file is in play. */
export interface MilestoneFile {
  path: string;
  action: 'create' | 'modify' | 'delete';
  regions?: { startLine: number; endLine: number }[];
}

/** The architect's output: the contract every later phase works against. */
export interface MilestoneSpec {
  id: string;
  title: string;
  summary: string;
  files: MilestoneFile[];
  acceptance: string[];
  /** Ids of milestones that must land before this one. */
  dependencies: string[];
}

export interface ImplResult {
  summary: string;
  changedFiles: string[];
  notes?: string[];
}

export interface QaFailure {
  /** Name of the test that broke the implementation. */
  test: string;
  detail: string;
}

export interface QaResult {
  summary: string;
  testsWritten: string[];
  failures: QaFailure[];
}

export interface AuditFinding {
  /** Only 'blocking' fails the run; major/minor are reported for the owner to weigh. */
  severity: 'blocking' | 'major' | 'minor';
  /** The standard or invariant cited, e.g. "OWASP A03:2021 Injection". */
  rule: string;
  detail: string;
  path?: string;
}

export interface AuditResult {
  summary: string;
  findings: AuditFinding[];
}

/** Everything one run produced, plus the verdict the owner actually acts on. */
export interface SwarmReport {
  spec: MilestoneSpec;
  impl: ImplResult;
  qa: QaResult;
  audit: AuditResult;
  /** 'pass' only when QA found no failures and the audit has no blocking findings. */
  verdict: 'pass' | 'fail';
}

/** What the implementer receives alongside the spec: the shared board and the lock manager. */
export interface SwarmPhaseContext {
  scratchpad: SharedScratchpad;
  locks: RegionLockManager;
  role: SwarmRoleId;
}

/**
 * The four roles' work, injected. Signatures mirror the pipeline: each executor sees the
 * outputs of the phases before it and nothing else.
 */
export interface SwarmExecutors {
  architect: (goal: string) => Promise<MilestoneSpec>;
  implementer: (spec: MilestoneSpec, ctx: SwarmPhaseContext) => Promise<ImplResult>;
  redTeam: (spec: MilestoneSpec, impl: ImplResult) => Promise<QaResult>;
  auditor: (spec: MilestoneSpec, impl: ImplResult, qa: QaResult) => Promise<AuditResult>;
}

export type SwarmPhase = SwarmRoleId;

/** Phase lifecycle, delivered to the coordinator's onEvent callback. */
export interface SwarmEvent {
  phase: SwarmPhase;
  stage: 'start' | 'done';
  at: number;
  /** The spec id once the architect has produced it; the goal before that. */
  detail: string;
}

export interface SwarmCoordinatorDeps {
  executors: SwarmExecutors;
  scratchpad: SharedScratchpad;
  locks: RegionLockManager;
  onEvent?: (event: SwarmEvent) => void;
  /** Clock for event timestamps; injectable for deterministic tests. */
  now?: () => number;
  /** Timeout for the implementer phase's lock acquisition; waits indefinitely when omitted. */
  lockTimeoutMs?: number;
}

/** Every region the spec puts in play: named regions, or the whole file when unnamed. */
export function specRegions(spec: MilestoneSpec): FileRegion[] {
  const regions: FileRegion[] = [];
  for (const file of spec.files) {
    if (file.regions?.length) {
      for (const r of file.regions) regions.push({ path: file.path, ...r });
    } else {
      regions.push(wholeFileRegion(file.path));
    }
  }
  return regions;
}

export class SwarmCoordinator {
  private readonly executors: SwarmExecutors;
  private readonly scratchpad: SharedScratchpad;
  private readonly locks: RegionLockManager;
  private readonly onEvent: ((event: SwarmEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number | undefined;

  constructor(deps: SwarmCoordinatorDeps) {
    this.executors = deps.executors;
    this.scratchpad = deps.scratchpad;
    this.locks = deps.locks;
    this.onEvent = deps.onEvent;
    this.now = deps.now ?? Date.now;
    this.lockTimeoutMs = deps.lockTimeoutMs;
  }

  /**
   * Run the pipeline for one goal. Phases run strictly in order (each consumes the last
   * phase's output); a throwing executor aborts the run and propagates, with the
   * implementer's locks released on the way out.
   */
  async run(goal: string): Promise<SwarmReport> {
    this.emit('architect', 'start', goal);
    const spec = await this.executors.architect(goal);
    this.scratchpad.put('spec', spec.id, spec);
    this.scratchpad.append({ ns: 'spec', key: spec.id, kind: 'phase-output' });
    this.emit('architect', 'done', spec.id);

    this.emit('implementer', 'start', spec.id);
    const ctx: SwarmPhaseContext = {
      scratchpad: this.scratchpad,
      locks: this.locks,
      role: 'implementer',
    };
    const handle = await this.locks.acquire('implementer', specRegions(spec), {
      ...(this.lockTimeoutMs !== undefined ? { timeoutMs: this.lockTimeoutMs } : {}),
    });
    let impl: ImplResult;
    try {
      impl = await this.executors.implementer(spec, ctx);
    } finally {
      handle.release();
    }
    this.scratchpad.put('impl', spec.id, impl);
    this.scratchpad.append({ ns: 'impl', key: spec.id, kind: 'phase-output' });
    this.emit('implementer', 'done', spec.id);

    this.emit('red-team', 'start', spec.id);
    const qa = await this.executors.redTeam(spec, impl);
    this.scratchpad.put('qa', spec.id, qa);
    this.scratchpad.append({ ns: 'qa', key: spec.id, kind: 'phase-output' });
    this.emit('red-team', 'done', spec.id);

    this.emit('auditor', 'start', spec.id);
    const audit = await this.executors.auditor(spec, impl, qa);
    this.scratchpad.put('audit', spec.id, audit);
    this.scratchpad.append({ ns: 'audit', key: spec.id, kind: 'phase-output' });
    this.emit('auditor', 'done', spec.id);

    const verdict: SwarmReport['verdict'] =
      qa.failures.length === 0 && !audit.findings.some((f) => f.severity === 'blocking')
        ? 'pass'
        : 'fail';
    this.scratchpad.append({ ns: 'audit', key: spec.id, kind: 'verdict', note: verdict });
    return { spec, impl, qa, audit, verdict };
  }

  private emit(phase: SwarmPhase, stage: SwarmEvent['stage'], detail: string): void {
    this.onEvent?.({ phase, stage, at: this.now(), detail });
  }
}
