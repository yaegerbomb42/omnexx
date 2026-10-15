import { describe, expect, it } from 'vitest';
import { buildCycleContext } from '../../../src/agent/context.js';
import { agentBrief } from '../../../src/core/agent-levels.js';
import type { Plan, PlanNode } from '../../../src/core/plan.js';

const task: PlanNode = {
  id: 'M1.T01',
  type: 'task',
  parentId: 'M1',
  title: 'Add login tests',
  why: 'login breaks often',
  acceptance: [],
  checks: [],
  dependsOn: [],
  size: 'M',
  kind: 'tests',
  steps: [],
  allow: [],
  status: 'doing',
  attempts: 0,
  consecutiveRejections: 0,
  approachesTried: [],
  failureSignatures: [],
  rung: 0,
  escalated: false,
  rungStartedAt: 0,
  splitInto: [],
  evidence: [],
};
const plan: Plan = {
  version: 1,
  goal: 'g',
  nodes: [{ ...task, id: 'M1', type: 'milestone', parentId: null, title: 'Auth' }, task],
};
const inputs = {
  systemPrompt: 'SYSTEM',
  codemap: '',
  goal: 'Ship auth',
  notes: 'LESSON one',
  plan,
  task,
  progressTail: '',
  evidence: [],
  tools: [],
};

const levels = { turnEffort: 5, contextLevel: 3, maxTokens: 4_096 };

describe('the agent settings brief in the cycle prompt', () => {
  it('adds a volatile block after the goal; the static prompt stays first', () => {
    const brief = agentBrief({ ...levels, taskEffort: 1, time: '5m' });
    const ctx = buildCycleContext({ ...inputs, brief });
    expect(ctx.labels).toEqual(['system', 'goal', 'settings', 'notes']);
    expect(ctx.system[0]).toEqual({ text: 'SYSTEM' });
    expect(ctx.system[2]?.volatile).toBe(true);
    expect(ctx.system[2]?.text).toMatch(/Effort per task: 1\/10 \(quick MVP/);
    expect(ctx.system[2]?.text).toMatch(/about 5m/);
  });

  it('says something different at level 10', () => {
    const brief = agentBrief({ ...levels, taskEffort: 10, time: 'unlimited' });
    const ctx = buildCycleContext({ ...inputs, brief });
    expect(ctx.system[2]?.text).toMatch(/monolith/);
    expect(ctx.system[2]?.text).toMatch(/no limit/);
  });

  it('adds nothing when no settings are saved', () => {
    expect(buildCycleContext(inputs).labels).toEqual(['system', 'goal', 'notes']);
  });
});

describe('the verified facts block in the cycle prompt', () => {
  it('is a volatile block after the settings, before the lessons', () => {
    const facts = '# Verified facts about this repo\n- [F1] test: tests pass with `npm test`';
    const ctx = buildCycleContext({ ...inputs, facts });
    expect(ctx.labels).toEqual(['system', 'goal', 'facts', 'notes']);
    expect(ctx.system[2]).toMatchObject({ text: facts, volatile: true });
  });
});
