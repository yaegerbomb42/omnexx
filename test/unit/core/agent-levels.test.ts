import { describe, expect, it } from 'vitest';
import {
  agentBrief,
  clampLevel,
  clampToWindow,
  contextBudget,
  contextProfile,
  levelsSummary,
  reasoningEffort,
  taskEffortBrief,
  taskEffortProfile,
  thinkingBudget,
  timeBrief,
  timeHours,
} from '../../../src/core/agent-levels.js';

describe('agent levels', () => {
  it('clamps levels to 1-10 and rounds them', () => {
    expect(clampLevel(0)).toBe(1);
    expect(clampLevel(11)).toBe(10);
    expect(clampLevel(4.6)).toBe(5);
    expect(clampLevel(Number.NaN)).toBe(1);
  });

  it('maps effort per task to more think turns, rounds and fuller plans as it rises', () => {
    const low = taskEffortProfile(1, 0.5);
    const mid = taskEffortProfile(5, 2);
    const high = taskEffortProfile(10, 8);
    expect(low).toEqual({ thinkTurns: 2, rounds: 2, rethinks: 0, planMode: 'fast', milestones: 1 });
    expect(mid.planMode).toBe('auto');
    expect(high).toMatchObject({ thinkTurns: 32, rounds: 18, rethinks: 5, planMode: 'full' });
    expect(high.milestones).toBeUndefined();
    expect(low.thinkTurns).toBeLessThan(mid.thinkTurns);
    expect(mid.thinkTurns).toBeLessThan(high.thinkTurns);
  });

  it('plans milestones at effort 6 when the person wants a long run', () => {
    expect(taskEffortProfile(6, 1).planMode).toBe('auto');
    expect(taskEffortProfile(6, 4).planMode).toBe('full');
  });

  it('tells the agent what its task-effort level means', () => {
    expect(taskEffortBrief(1)).toMatch(/^Effort per task: 1\/10 \(quick MVP/);
    expect(taskEffortBrief(1)).toMatch(/smallest thing that works/);
    expect(taskEffortBrief(10)).toMatch(/10\/10 \(monolith/);
    expect(taskEffortBrief(10)).toMatch(/architecture and milestone plan/);
    // Every level says something different.
    const all = Array.from({ length: 10 }, (_, i) => taskEffortBrief(i + 1));
    expect(new Set(all).size).toBe(10);
  });

  it('maps effort per turn to reasoning_effort and a thinking budget', () => {
    expect(reasoningEffort(1)).toBe('minimal');
    expect(reasoningEffort(3)).toBe('low');
    expect(reasoningEffort(5)).toBe('medium');
    expect(reasoningEffort(10)).toBe('high');
    expect(thinkingBudget(1)).toBe(0);
    expect(thinkingBudget(10)).toBe(32_000);
  });

  it('gives ten context budgets from 5k to 500k', () => {
    expect(contextBudget(1)).toBe(5_000);
    expect(contextBudget(5)).toBe(64_000);
    expect(contextBudget(10)).toBe(500_000);
  });

  it('keeps only the bare minimum at 5k and everything at 500k', () => {
    const bare = contextProfile(1);
    expect(bare).toMatchObject({ compactAt: 5_000, clearAt: 3_000, keepTurns: 1, bare: true });
    expect(bare.repoMapMaxTokens).toBeLessThanOrEqual(250);
    const all = contextProfile(10);
    expect(all).toMatchObject({ compactAt: 500_000, keepTurns: 20, bare: false });
    expect(all.repoMapMaxTokens).toBe(12_000);
  });

  it("clamps the context budget to the model's window", () => {
    expect(clampToWindow(500_000, 128_000)).toBe(108_800);
    expect(clampToWindow(5_000, 128_000)).toBe(5_000);
    expect(clampToWindow(64_000, undefined)).toBe(64_000);
    expect(contextProfile(10, 200_000).compactAt).toBe(170_000);
  });

  it('turns time into hours and a planning hint', () => {
    expect(timeHours('30m')).toBe(0.5);
    expect(timeHours('8h')).toBe(8);
    expect(timeHours('unlimited')).toBeGreaterThan(1_000);
    expect(timeBrief('30m')).toMatch(/about 30m/);
    expect(timeBrief('unlimited')).toMatch(/no limit/);
  });

  it('summarizes for the status bar and briefs the agent', () => {
    const l = {
      taskEffort: 6,
      turnEffort: 4,
      contextLevel: 5,
      time: '30m' as const,
      maxTokens: 8_192,
    };
    expect(levelsSummary(l)).toBe('effort 6/4 · ctx 64k · 30m');
    expect(agentBrief(l)).toMatch(/^# Your settings\n\nEffort per task: 6\/10/);
    expect(agentBrief(l)).toMatch(/about 30m/);
  });
});
