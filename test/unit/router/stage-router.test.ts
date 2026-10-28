import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../../src/router/candidates.js';
import {
  rankCandidatesForStage,
  STAGE_POLICIES,
  stageForAction,
} from '../../../src/router/stage.js';

describe('stageForAction', () => {
  it('maps exploration actions to exploration stage', () => {
    expect(stageForAction('read-explore')).toBe('exploration');
    expect(stageForAction('docs')).toBe('exploration');
    expect(stageForAction('summarize')).toBe('exploration');
    expect(stageForAction('compact')).toBe('exploration');
    expect(stageForAction('browser-step')).toBe('exploration');
  });

  it('maps architecture & complex refactoring to architecture stage', () => {
    expect(stageForAction('plan')).toBe('architecture');
    expect(stageForAction('replan')).toBe('architecture');
    expect(stageForAction('split')).toBe('architecture');
    expect(stageForAction('refactor')).toBe('architecture');
    expect(stageForAction('edit-large')).toBe('architecture');
    expect(stageForAction('debug-failure')).toBe('architecture');
  });

  it('maps test and lint verification to verification stage', () => {
    expect(stageForAction('write-tests')).toBe('verification');
    expect(stageForAction('edit-small')).toBe('verification');
  });
});

describe('STAGE_POLICIES', () => {
  it('defines recommended tiers matching the strategy matrix', () => {
    expect(STAGE_POLICIES.exploration.tier).toBe('fast-low-cost');
    expect(STAGE_POLICIES.exploration.preferredRole).toBe('cheap');

    expect(STAGE_POLICIES.architecture.tier).toBe('high-reasoning');
    expect(STAGE_POLICIES.architecture.preferredRole).toBe('planner');

    expect(STAGE_POLICIES.verification.tier).toBe('fast-low-cost');
    expect(STAGE_POLICIES.verification.preferredRole).toBe('cheap');
  });
});

describe('rankCandidatesForStage', () => {
  const mockCandidate = (
    ref: string,
    quality: Candidate['quality'],
    speed: Candidate['speed'],
    roles: Candidate['roles'],
  ): Candidate => {
    const [provider = 'anthropic', id = 'model'] = ref.split(':');
    return {
      ref,
      model: {
        provider,
        id,
        alias: id,
        price: {
          id,
          input: 1,
          output: 2,
          cache_write_5m: 1,
          cache_write_1h: 1,
          cache_read: 0.1,
        },
      },
      roles,
      profile: {
        tags: [],
        tools: true,
        vision: false,
        quality,
        speed,
      },
      quality,
      speed,
    };
  };

  const highReasoningCandidate = mockCandidate('anthropic:claude-3-7-sonnet', 'high', 'normal', ['planner']);
  const fastLowCostCandidate = mockCandidate('google:gemini-2.0-flash', 'low', 'fast', ['cheap']);

  const candidates: Candidate[] = [highReasoningCandidate, fastLowCostCandidate];

  it('prioritizes high-reasoning models for architecture stage', () => {
    const ranked = rankCandidatesForStage(candidates, 'architecture');
    expect(ranked[0]?.ref).toBe('anthropic:claude-3-7-sonnet');
    expect(ranked[1]?.ref).toBe('google:gemini-2.0-flash');
  });

  it('prioritizes fast/low-cost models for exploration stage', () => {
    const ranked = rankCandidatesForStage(candidates, 'exploration');
    expect(ranked[0]?.ref).toBe('google:gemini-2.0-flash');
    expect(ranked[1]?.ref).toBe('anthropic:claude-3-7-sonnet');
  });

  it('prioritizes fast/low-cost models for verification stage', () => {
    const ranked = rankCandidatesForStage(candidates, 'verification');
    expect(ranked[0]?.ref).toBe('google:gemini-2.0-flash');
    expect(ranked[1]?.ref).toBe('anthropic:claude-3-7-sonnet');
  });
});
