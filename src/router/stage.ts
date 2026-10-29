import type { Candidate } from './candidates.js';
import type { Role, RouteAction } from './actions.js';

export type TaskStage = 'exploration' | 'architecture' | 'verification';

export interface StagePolicy {
  stage: TaskStage;
  tier: 'fast-low-cost' | 'high-reasoning';
  preferredRole: Role;
  targetQuality: 'low' | 'mid' | 'high';
  description: string;
}

export const STAGE_POLICIES: Record<TaskStage, StagePolicy> = {
  exploration: {
    stage: 'exploration',
    tier: 'fast-low-cost',
    preferredRole: 'cheap',
    targetQuality: 'low',
    description: 'Fast / Low-Cost for grepping, listing directories, reading ASTs (Gemini Flash, Claude Haiku, Qwen 2.5 14B)',
  },
  architecture: {
    stage: 'architecture',
    tier: 'high-reasoning',
    preferredRole: 'planner',
    targetQuality: 'high',
    description: 'High-Reasoning for designing patches, complex refactoring (Claude Sonnet 3.7 / Opus, DeepSeek-R1, GPT-4o)',
  },
  verification: {
    stage: 'verification',
    tier: 'fast-low-cost',
    preferredRole: 'cheap',
    targetQuality: 'low',
    description: 'Fast / Low-Cost for test suite runs and lint triage (Local Ollama, small models)',
  },
};

/**
 * Maps a route action to its task execution stage.
 */
export function stageForAction(action: RouteAction): TaskStage {
  switch (action) {
    case 'read-explore':
    case 'docs':
    case 'summarize':
    case 'compact':
    case 'browser-step':
    case 'commit-message':
      return 'exploration';

    case 'plan':
    case 'replan':
    case 'split':
    case 'refactor':
    case 'edit-large':
    case 'debug-failure':
    case 'intent-infer':
    case 'beyond-ideate':
    case 'review-diff':
      return 'architecture';

    case 'write-tests':
    case 'edit-small':
      return 'verification';
  }
}

/**
 * Ranks model candidates based on the stage's recommended tier.
 * - Architecture: prefers high-reasoning models (high quality, Sonnet/Opus/R1/GPT-4o).
 * - Exploration & Verification: prefers fast, cost-efficient models (low quality / fast speed, Flash/Haiku/Ollama/Qwen).
 */
export function rankCandidatesForStage(
  candidates: readonly Candidate[],
  stage: TaskStage,
): Candidate[] {
  const policy = STAGE_POLICIES[stage];
  const list = [...candidates];

  list.sort((a, b) => {
    if (policy.tier === 'high-reasoning') {
      const qScore = (c: Candidate): number => (c.quality === 'high' ? 3 : c.quality === 'mid' ? 2 : 1);
      return qScore(b) - qScore(a);
    }
    // fast-low-cost tier: prefer fast speed, then cheap role, then low quality
    const sScore = (c: Candidate): number => {
      let score = 0;
      if (c.speed === 'fast') score += 4;
      if (c.roles.includes(policy.preferredRole)) score += 2;
      if (c.quality === 'low') score += 1;
      return score;
    };
    return sScore(b) - sScore(a);
  });

  return list;
}
