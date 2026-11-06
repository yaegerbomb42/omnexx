/**
 * PriorityScore triage engine for the autonomous daemon.
 *
 * Every raw finding from a collector is fingerprinted, deduplicated against
 * the done-set and the tombstone registry, scored, and either admitted to
 * the work queue or dropped to the discarded-findings log.
 *
 * PriorityScore = (35*severity + 25*confidence + 25*verification + 15*hotness)
 *                 / (1 + 0.6*blastRadius + 0.4*tokenCost)
 *                 * cooldownMultiplier
 *
 * cooldownMultiplier is 0.25 when an autonomous task touched any target
 * file in the last 6h (churn guard: don't hammer a file the daemon just
 * shipped), otherwise 1.0. Admission threshold is 32.0.
 */
import { computeTaskFingerprint } from './fingerprint.js';
import type { AutonomousStateStore } from './state-store.js';

/** Minimum PriorityScore for a finding to reach the work queue. */
export const MIN_ADMISSION_SCORE = 32.0;
/** Multiplier applied when a target file was touched recently. */
export const COOLDOWN_MULTIPLIER = 0.25;
/** Churn-guard window: target file modified by an autonomous task within this. */
export const COOLDOWN_WINDOW_MS = 6 * 60 * 60 * 1000;

export type FindingKind =
  | 'failing-test'
  | 'cve'
  | 'type-error'
  | 'uncovered-critical'
  | 'patch-dependency'
  | 'complexity'
  | 'todo';

/** Severity weights per finding kind (design table). */
export const SEVERITY_BY_KIND: Readonly<Record<FindingKind, number>> = {
  'failing-test': 1.0,
  cve: 1.0,
  'type-error': 0.9,
  'uncovered-critical': 0.7,
  'patch-dependency': 0.5,
  complexity: 0.3,
  todo: 0.2,
};

export function severityForKind(kind: FindingKind): number {
  return SEVERITY_BY_KIND[kind];
}

export interface RawFinding {
  /** Which collector produced the finding (e.g. 'test-runner', 'typecheck'). */
  collector: string;
  /** Rule or test id; volatile line numbers are stripped before fingerprinting. */
  ruleOrTestId: string;
  /** Canonical symbol the finding is about, if any. */
  symbol?: string;
  /** Target files, relative to the repo root. */
  targetFiles: readonly string[];
  kind: FindingKind;
  /** 0..1 — how sure the collector is that the finding is real. */
  confidence: number;
  /** 0..1 — how verifiable the fix is (failing test, repro, type error). */
  verification: number;
  /** 0..1 — recency / frequency signal. */
  hotness: number;
  /** 0..1 — estimated blast radius of the change. */
  blastRadius: number;
  /** 0..1 — estimated relative token cost of the fix. */
  tokenCost: number;
  /** Original collector payload, stored verbatim on the queued task. */
  payload?: unknown;
}

export interface CandidateTask {
  fingerprint: string;
  collector: string;
  ruleOrTestId: string;
  symbol: string | null;
  targetFiles: string[];
  kind: FindingKind;
  priorityScore: number;
  finding: RawFinding;
}

export interface ScoreInput {
  severity: number;
  confidence: number;
  verification: number;
  hotness: number;
  blastRadius: number;
  tokenCost: number;
  /** True when a target file was touched by an autonomous task in the last 6h. */
  cooldownActive: boolean;
}

/** Pure PriorityScore computation — no I/O, unit-testable in isolation. */
export function computePriorityScore(input: ScoreInput): number {
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const numerator =
    35 * clamp01(input.severity) +
    25 * clamp01(input.confidence) +
    25 * clamp01(input.verification) +
    15 * clamp01(input.hotness);
  const denominator = 1 + 0.6 * clamp01(input.blastRadius) + 0.4 * clamp01(input.tokenCost);
  const multiplier = input.cooldownActive ? COOLDOWN_MULTIPLIER : 1.0;
  return (numerator / denominator) * multiplier;
}

export type TriageDecision =
  | { decision: 'admitted'; fingerprint: string; task: CandidateTask; score: number }
  | { decision: 'duplicate'; fingerprint: string; score: number; reason: string }
  | { decision: 'tombstoned'; fingerprint: string; score: number; reason: string }
  | { decision: 'discarded'; fingerprint: string; score: number; reason: string };

export interface TriageEngineOptions {
  repoRoot: string;
  minAdmissionScore?: number;
  now?: () => number;
}

export class TriageEngine {
  private readonly store: AutonomousStateStore;
  private readonly repoRoot: string;
  private readonly minAdmissionScore: number;
  private readonly now: () => number;

  constructor(store: AutonomousStateStore, opts: TriageEngineOptions) {
    this.store = store;
    this.repoRoot = opts.repoRoot;
    this.minAdmissionScore = opts.minAdmissionScore ?? MIN_ADMISSION_SCORE;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Score a candidate task. Looks up the churn guard in the state store:
   * 0.25x when any target file was modified by an autonomous task in the
   * last 6h, otherwise 1.0x.
   */
  scoreTask(task: CandidateTask): number {
    const cooldownActive = this.store.filesTouchedSince(
      task.targetFiles,
      this.now() - COOLDOWN_WINDOW_MS,
    );
    return computePriorityScore({
      severity: severityForKind(task.kind),
      confidence: task.finding.confidence,
      verification: task.finding.verification,
      hotness: task.finding.hotness,
      blastRadius: task.finding.blastRadius,
      tokenCost: task.finding.tokenCost,
      cooldownActive,
    });
  }

  /** Build a candidate (fingerprint + unscored placeholder) for a finding. */
  toCandidate(finding: RawFinding): CandidateTask {
    const fingerprint = computeTaskFingerprint(finding, this.repoRoot);
    return {
      fingerprint,
      collector: finding.collector,
      ruleOrTestId: finding.ruleOrTestId,
      symbol: finding.symbol ?? null,
      targetFiles: [...finding.targetFiles],
      kind: finding.kind,
      priorityScore: 0,
      finding,
    };
  }

  /**
   * Full triage pipeline for one raw finding:
   * 1. fingerprint + dedupe against done_set (already shipped),
   * 2. dedupe against tombstone_registry (cooling down; the daemon loop
   *    unlocks a tombstone separately via isTombstoneUnlocked when the
   *    target blobs change),
   * 3. score; below the admission threshold the finding is dropped to the
   *    discarded-findings log,
   * 4. otherwise enqueue.
   */
  triageFinding(finding: RawFinding): TriageDecision {
    const candidate = this.toCandidate(finding);

    if (this.store.isDone(candidate.fingerprint)) {
      return {
        decision: 'duplicate',
        fingerprint: candidate.fingerprint,
        score: 0,
        reason: 'fingerprint already in done_set',
      };
    }

    if (this.store.isTombstoned(candidate.fingerprint, this.now())) {
      // A matching fingerprint means the target blobs are unchanged (blob
      // SHAs are part of the fingerprint), so the failure still applies.
      // External invalidation is handled separately: when a target file is
      // edited, the fingerprint changes and the daemon loop unlocks the old
      // tombstone via store.isTombstoneUnlocked() + clearTombstone().
      const tombstone = this.store.getTombstone(candidate.fingerprint);
      return {
        decision: 'tombstoned',
        fingerprint: candidate.fingerprint,
        score: 0,
        reason: `tombstoned (strike ${tombstone?.strikeCount ?? '?'}, cooldown until ${tombstone?.cooldownUntilMs ?? '?'})`,
      };
    }

    const score = this.scoreTask(candidate);
    candidate.priorityScore = score;

    if (score < this.minAdmissionScore) {
      this.store.recordDiscardedFinding({
        fingerprint: candidate.fingerprint,
        sourceCollector: candidate.collector,
        priorityScore: score,
        reason: `score ${score.toFixed(2)} below admission threshold ${this.minAdmissionScore}`,
        findingPayload: finding,
      });
      return {
        decision: 'discarded',
        fingerprint: candidate.fingerprint,
        score,
        reason: `score ${score.toFixed(2)} below admission threshold ${this.minAdmissionScore}`,
      };
    }

    this.store.enqueueTask({
      fingerprint: candidate.fingerprint,
      sourceCollector: candidate.collector,
      priorityScore: score,
      targetFiles: candidate.targetFiles,
      findingPayload: finding,
    });
    return { decision: 'admitted', fingerprint: candidate.fingerprint, task: candidate, score };
  }
}
