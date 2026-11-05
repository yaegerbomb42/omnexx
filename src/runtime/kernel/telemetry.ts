import type { ModelProfileHints, TelemetrySnapshot } from './types.js';

export interface ToolObservation {
  tool: string;
  inputSummary: string;
  isError: boolean;
  /** Non-zero exit, syntax/lint/compiler failure, or provider-flagged tool error. */
  kind?: 'syntax' | 'exit' | 'lint' | 'compiler' | 'repeat' | 'other' | undefined;
  /** Estimated tokens of the next prompt (system + tools + messages). */
  promptTokens?: number | undefined;
  /** Validated state progress this turn (file edits that stuck, tests that passed). */
  stateProgress?: number | undefined;
}

export interface LogprobToken {
  logprob: number;
}

/**
 * Deterministic PID-style telemetry for the hybrid control plane.
 * Instant threshold checks; no network, no LLM.
 */
export class TelemetryMonitor {
  private frictionScore = 0;
  private consecutiveFailures = 0;
  private lastToolSignature = '';
  private contextPressure = 0;
  private epistemicUncertainty = 0;
  private turn = 0;
  private readonly profile: ModelProfileHints;

  constructor(profile: ModelProfileHints) {
    this.profile = {
      maxWindow: profile.maxWindow,
      attentionCeiling: profile.attentionCeiling > 0 ? profile.attentionCeiling : 0.65,
      maxMountedTools: profile.maxMountedTools,
    };
  }

  snapshot(): TelemetrySnapshot {
    return {
      frictionScore: this.frictionScore,
      contextPressure: this.contextPressure,
      epistemicUncertainty: this.epistemicUncertainty,
      consecutiveFailures: this.consecutiveFailures,
      lastToolSignature: this.lastToolSignature,
      turn: this.turn,
    };
  }

  /** Advance the turn counter (call once per model turn). */
  beginTurn(turn: number): void {
    this.turn = turn;
  }

  /**
   * Update context pressure \(P_t\) = promptTokens / (maxWindow * attentionCeiling).
   * Clamped to [0, 2] so extreme overruns remain visible without overflowing heuristics.
   */
  setPromptTokens(promptTokens: number): void {
    const ceiling = Math.max(1, this.profile.maxWindow * this.profile.attentionCeiling);
    this.contextPressure = Math.min(2, Math.max(0, promptTokens / ceiling));
  }

  /**
   * Shannon entropy of token logprobs, normalized to [0, 1] by log(|vocab-ish|).
   * When the provider returns no logprobs, leaves the previous value unchanged.
   */
  observeLogprobs(tokens: readonly LogprobToken[] | undefined): void {
    if (!tokens || tokens.length === 0) return;
    // H = -Σ p log p with p = exp(logprob). Cap by log(N) ≈ natural scale of the sample.
    let entropy = 0;
    for (const t of tokens) {
      const p = Math.exp(t.logprob);
      if (p > 0) entropy -= p * Math.log(p);
    }
    const norm = Math.log(Math.max(2, tokens.length));
    this.epistemicUncertainty = Math.min(1, entropy / norm);
  }

  /**
   * Cosine-distance style divergence across parallel rollout embeddings or text hashes.
   * `scores` are pairwise similarities in [0, 1]; uncertainty is 1 - mean similarity.
   */
  observeDivergence(similarities: readonly number[]): void {
    if (similarities.length === 0) return;
    const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    this.epistemicUncertainty = Math.min(1, Math.max(0, 1 - mean));
  }

  /** Record one tool outcome; updates friction and optional progress reset. */
  observeTool(obs: ToolObservation): void {
    if (obs.promptTokens !== undefined) this.setPromptTokens(obs.promptTokens);

    const signature = `${obs.tool}:${obs.inputSummary}`;
    const repeated = signature === this.lastToolSignature && obs.isError;
    this.lastToolSignature = signature;

    if (obs.stateProgress !== undefined && obs.stateProgress > 0) {
      this.frictionScore = 0;
      this.consecutiveFailures = 0;
      return;
    }

    if (!obs.isError && !repeated) {
      // Successful non-progress call: decay friction slightly so transient noise drains.
      this.frictionScore = Math.max(0, this.frictionScore - 0.25);
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures += 1;
    let bump = 1;
    if (obs.kind === 'syntax' || obs.kind === 'lint' || obs.kind === 'compiler') bump = 1.5;
    if (obs.kind === 'exit') bump = 1.25;
    if (repeated || obs.kind === 'repeat') bump = 2;
    this.frictionScore += bump;
  }

  /** True when friction suggests a checkpoint rollback is warranted. */
  shouldRollback(threshold = 4): boolean {
    return this.frictionScore >= threshold || this.consecutiveFailures >= 3;
  }

  /** True when context pressure warrants GC / compaction tier. */
  needsCompaction(threshold = 0.9): boolean {
    return this.contextPressure >= threshold;
  }
}

/** Classify a tool error string into a friction kind. */
export function classifyToolError(content: string): ToolObservation['kind'] {
  const s = content.toLowerCase();
  if (/syntaxerror|unexpected token|parse error/.test(s)) return 'syntax';
  if (/eslint|prettier|ruff|clippy/.test(s)) return 'lint';
  if (/error ts\d|cannot find name|typeerror|tsc\b|compiler/.test(s)) return 'compiler';
  if (/exit code[=:\s]+[1-9]|non-zero|command failed/.test(s)) return 'exit';
  return 'other';
}
