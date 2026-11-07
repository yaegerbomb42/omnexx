import { clamp01, fingerprint } from './common.js';
import { CoverageChurnCollector } from './coverage-churn.js';
import { ComplexityCollector } from './complexity.js';
import { DependencyCollector } from './dependency.js';
import { PerfBenchmarkCollector } from './perf-benchmark.js';
import { SelfReviewCollector } from './self-review.js';
import { StaticAnalysisCollector } from './static-analysis.js';
import { TelemetryCollector } from './telemetry.js';
import { TestRunnerCollector } from './test-runner.js';
import { TodoMiningCollector } from './todo-mining.js';

/**
 * One raw, unverified observation from a discovery collector.
 * Downstream stages (dedupe, scoring, verification) refine these into tasks.
 */
export interface RawFinding {
  /** Collector that produced this finding, e.g. 'test_runner'. */
  collector: string;
  /** Rule id or test id the finding refers to, e.g. 'TS2304' or 'src/foo.test.ts > bar'. */
  ruleOrTestId: string;
  /** Canonical symbol the finding is about, when one can be identified. */
  canonicalSymbol?: string;
  /** Repo-relative files the finding touches. */
  targetFiles: string[];
  /** Severity 0..1 (1 = must fix now, e.g. a failing test). */
  severity: number;
  /** Confidence 0..1 that the finding is real and actionable. */
  confidence: number;
  /** Verification 0..1: how strongly the finding has been independently confirmed. */
  verification: number;
  /** Collector-specific detail; must be JSON-serializable. */
  findingPayload: unknown;
}

/** Every discovery collector is deterministic (no LLM calls) and never throws. */
export interface DiscoveryCollector {
  /** Stable name, e.g. 'test_runner'. Used in RawFinding.collector and for enablement. */
  readonly name: string;
  /** Collect raw findings from the repo at repoRoot. Returns [] on any tool failure. */
  collect(repoRoot: string): Promise<RawFinding[]>;
}

/** Build a RawFinding with clamped scores and a stable fingerprint. */
export function makeFinding(input: {
  collector: string;
  ruleOrTestId: string;
  canonicalSymbol?: string;
  targetFiles: string[];
  severity: number;
  confidence: number;
  verification?: number;
  findingPayload: unknown;
}): RawFinding {
  const finding: RawFinding = {
    collector: input.collector,
    ruleOrTestId: input.ruleOrTestId,
    targetFiles: input.targetFiles,
    severity: clamp01(input.severity),
    confidence: clamp01(input.confidence),
    verification: clamp01(input.verification ?? 0),
    findingPayload: input.findingPayload,
  };
  if (input.canonicalSymbol !== undefined) finding.canonicalSymbol = input.canonicalSymbol;
  return finding;
}

/** Fingerprint used for dedupe and for bounding self-repair attempts. */
export function findingFingerprint(finding: RawFinding): string {
  return fingerprint([finding.collector, finding.ruleOrTestId, ...finding.targetFiles]);
}

export interface DiscoveryOptions {
  /** Collector names to run. Defaults to all registered collectors. */
  enabled?: string[];
  /** Per-collector timeout in ms. Defaults to 120_000. */
  timeoutMs?: number;
}

/** All registered collectors, in priority order. */
export const ALL_COLLECTORS: DiscoveryCollector[] = [
  new TestRunnerCollector(),
  new StaticAnalysisCollector(),
  new SelfReviewCollector(),
  new CoverageChurnCollector(),
  new DependencyCollector(),
  new TelemetryCollector(),
  new PerfBenchmarkCollector(),
  new ComplexityCollector(),
  new TodoMiningCollector(),
];

export const COLLECTOR_NAMES: string[] = ALL_COLLECTORS.map((c) => c.name);

/**
 * Runs the enabled collectors and merges their findings.
 * A failing collector never takes down the run: it contributes [] and the
 * failure is recorded in `errors` so the orchestrator can report it.
 */
export class DiscoveryOrchestrator {
  private readonly collectors: DiscoveryCollector[];

  constructor(collectors: DiscoveryCollector[] = ALL_COLLECTORS) {
    this.collectors = collectors;
  }

  async collect(
    repoRoot: string,
    options: DiscoveryOptions = {},
  ): Promise<{ findings: RawFinding[]; errors: Record<string, string> }> {
    const enabled = new Set(options.enabled ?? COLLECTOR_NAMES);
    const findings: RawFinding[] = [];
    const errors: Record<string, string> = {};

    for (const collector of this.collectors) {
      if (!enabled.has(collector.name)) continue;
      try {
        const collected = await collector.collect(repoRoot);
        findings.push(...collected);
      } catch (err) {
        // Contract: collectors must not throw, but the orchestrator is the last line
        // of defence — a rogue collector degrades to [] instead of killing the run.
        errors[collector.name] = err instanceof Error ? err.message : String(err);
      }
    }

    // Highest severity first; ties broken by confidence, then collector name.
    findings.sort(
      (a, b) =>
        b.severity - a.severity ||
        b.confidence - a.confidence ||
        a.collector.localeCompare(b.collector),
    );
    return { findings, errors };
  }
}

/** Convenience entry point: run the default orchestrator over a repo. */
export async function runDiscovery(
  repoRoot: string,
  options: DiscoveryOptions = {},
): Promise<{ findings: RawFinding[]; errors: Record<string, string> }> {
  return new DiscoveryOrchestrator().collect(repoRoot, options);
}
