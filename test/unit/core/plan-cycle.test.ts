import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, type PlanUpdate } from '../../../src/core/plan.js';

interface Task {
  id: string;
  title: string;
  dependsOn?: string[];
}

/** One-milestone plan built from `[id, dependsOn]` pairs. */
const tasksPlan = (...tasks: [string, string[]?][]): PlanUpdate => ({
  milestones: [
    {
      id: 'M1',
      title: 'Milestone one',
      tasks: tasks.map(([id, dependsOn]): Task => ({
        id,
        title: `Task ${id}`,
        ...(dependsOn ? { dependsOn } : {}),
      })),
    },
  ],
});

const apply = (update: PlanUpdate) => applyPlanUpdate(undefined, update, 'goal');
const CYCLE = /depends on .* in a cycle/;

describe('applyPlanUpdate cycle detection (plan-cycle.test.ts)', () => {
  it.each([
    ['a direct two-node', tasksPlan(['M1.T01', ['M1.T02']], ['M1.T02', ['M1.T01']])],
    [
      'a three-node',
      tasksPlan(['M1.T01', ['M1.T02']], ['M1.T02', ['M1.T03']], ['M1.T03', ['M1.T01']]),
    ],
    [
      'a milestone-level',
      {
        milestones: [
          { id: 'M1', title: 'First', dependsOn: ['M2'] },
          { id: 'M2', title: 'Second', dependsOn: ['M1'] },
        ],
      } satisfies PlanUpdate,
    ],
  ])('rejects %s dependsOn cycle', (_name, update) => {
    expect(() => apply(update)).toThrow(CYCLE);
  });

  it('reports the ids of the cycle it found', () => {
    let message = '';
    try {
      apply(tasksPlan(['M1.T01', ['M1.T02']], ['M1.T02', ['M1.T01']]));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('M1.T01');
    expect(message).toContain('M1.T02');
    expect(message).toMatch(/in a cycle$/);
  });

  it('accepts a simple chain', () => {
    const plan = apply(tasksPlan(['M1.T01'], ['M1.T02', ['M1.T01']]));
    expect(plan.nodes.map((n) => n.id)).toEqual(['M1', 'M1.T01', 'M1.T02']);
  });

  it('accepts a plan with no dependsOn', () => {
    expect(apply(tasksPlan(['M1.T01'], ['M1.T02'])).nodes).toHaveLength(3);
  });

  it('accepts a diamond dependency (acyclic)', () => {
    const plan = apply(
      tasksPlan(
        ['M1.T01'],
        ['M1.T02', ['M1.T01']],
        ['M1.T03', ['M1.T01']],
        ['M1.T04', ['M1.T02', 'M1.T03']],
      ),
    );
    expect(plan.nodes).toHaveLength(5);
  });
});
