import { describe, expect, it } from 'vitest';
import {
  GENERAL_PLANNER_SYSTEM,
  GENERAL_WORKER_SYSTEM,
  PLANNER_SYSTEM,
  WORKER_SYSTEM,
  getPlannerPrompt,
  getWorkerPrompt,
} from '../../../src/agent/prompts.js';

describe('prompt selection by work domain', () => {
  it('swe returns the original prompts byte-identical', () => {
    expect(getWorkerPrompt('swe')).toBe(WORKER_SYSTEM);
    expect(getPlannerPrompt('swe')).toBe(PLANNER_SYSTEM);
  });

  it('general returns the artifact-oriented variants', () => {
    expect(getWorkerPrompt('general')).toBe(GENERAL_WORKER_SYSTEM);
    expect(getPlannerPrompt('general')).toBe(GENERAL_PLANNER_SYSTEM);
    expect(GENERAL_WORKER_SYSTEM).not.toBe(WORKER_SYSTEM);
    expect(GENERAL_PLANNER_SYSTEM).not.toBe(PLANNER_SYSTEM);
  });

  it('general worker framing is about artifacts and acceptance criteria, not code navigation', () => {
    expect(GENERAL_WORKER_SYSTEM).toContain('artifact');
    expect(GENERAL_WORKER_SYSTEM).toContain('acceptance criteria');
    // No code-only instructions: no symbol navigation, no test-running duty, no codebase map.
    expect(GENERAL_WORKER_SYSTEM).not.toContain('read_symbol');
    expect(GENERAL_WORKER_SYSTEM).not.toContain('Run the relevant tests');
    expect(GENERAL_WORKER_SYSTEM).not.toContain('codebase map');
  });

  it('general planner framing uses milestone deliverables and non-test checks', () => {
    expect(GENERAL_PLANNER_SYSTEM).toContain('milestones');
    expect(GENERAL_PLANNER_SYSTEM).toContain('acceptance criteria');
    expect(GENERAL_PLANNER_SYSTEM).toContain('No test suite is required');
    expect(GENERAL_PLANNER_SYSTEM).not.toContain('codebase');
  });
});
