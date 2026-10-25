import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, type PlanUpdate } from '../../../src/core/plan.js';

const acyclic: PlanUpdate = {
  milestones: [
    {
      id: 'M1',
      title: 'Core',
      tasks: [
        { id: 'M1.T01', title: 'Add schema' },
        { id: 'M1.T02', title: 'Add loader', dependsOn: ['M1.T01'] },
      ],
    },
  ],
};

describe('applyPlanUpdate cycle detection (plan-cycle.test.ts)', () => {
  it('rejects a direct two-node dependsOn cycle', () => {
    expect(() =>
      applyPlanUpdate(
        undefined,
        {
          milestones: [
            {
              id: 'M1',
              title: 'Cycle test',
              tasks: [
                { id: 'M1.T01', title: 'Task A', dependsOn: ['M1.T02'] },
                { id: 'M1.T02', title: 'Task B', dependsOn: ['M1.T01'] },
              ],
            },
          ],
        },
        'goal',
      ),
    ).toThrow(/depends on .* in a cycle/);
  });

  it('rejects a three-node cycle', () => {
    expect(() =>
      applyPlanUpdate(
        undefined,
        {
          milestones: [
            {
              id: 'M1',
              title: 'Three-cycle',
              tasks: [
                { id: 'M1.T01', title: 'Task A', dependsOn: ['M1.T02'] },
                { id: 'M1.T02', title: 'Task B', dependsOn: ['M1.T03'] },
                { id: 'M1.T03', title: 'Task C', dependsOn: ['M1.T01'] },
              ],
            },
          ],
        },
        'goal',
      ),
    ).toThrow(/depends on .* in a cycle/);
  });

  it('rejects a milestone-level cycle', () => {
    expect(() =>
      applyPlanUpdate(
        undefined,
        {
          milestones: [
            { id: 'M1', title: 'First', dependsOn: ['M2'] },
            { id: 'M2', title: 'Second', dependsOn: ['M1'] },
          ],
        },
        'goal',
      ),
    ).toThrow(/depends on .* in a cycle/);
  });

  it('reports the ids of the cycle it found', () => {
    let message = '';
    try {
      applyPlanUpdate(
        undefined,
        {
          milestones: [
            {
              id: 'M1',
              title: 'Cycle test',
              tasks: [
                { id: 'M1.T01', title: 'Task A', dependsOn: ['M1.T02'] },
                { id: 'M1.T02', title: 'Task B', dependsOn: ['M1.T01'] },
              ],
            },
          ],
        },
        'goal',
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('M1.T01');
    expect(message).toContain('M1.T02');
    expect(message).toMatch(/in a cycle$/);
  });

  it('accepts the original acyclic plan', () => {
    const plan = applyPlanUpdate(undefined, acyclic, 'goal');
    expect(plan.nodes.map((n) => n.id)).toEqual(['M1', 'M1.T01', 'M1.T02']);
  });

  it('accepts a plan with no dependsOn', () => {
    const plan = applyPlanUpdate(
      undefined,
      {
        milestones: [
          {
            id: 'M1',
            title: 'Simple',
            tasks: [
              { id: 'M1.T01', title: 'Task A' },
              { id: 'M1.T02', title: 'Task B' },
            ],
          },
        ],
      },
      'goal',
    );
    expect(plan.nodes).toHaveLength(3);
  });

  it('accepts a diamond dependency (acyclic)', () => {
    const plan = applyPlanUpdate(
      undefined,
      {
        milestones: [
          {
            id: 'M1',
            title: 'Diamond',
            tasks: [
              { id: 'M1.T01', title: 'root' },
              { id: 'M1.T02', title: 'left', dependsOn: ['M1.T01'] },
              { id: 'M1.T03', title: 'right', dependsOn: ['M1.T01'] },
              { id: 'M1.T04', title: 'merged', dependsOn: ['M1.T02', 'M1.T03'] },
            ],
          },
        ],
      },
      'goal',
    );
    expect(plan.nodes).toHaveLength(5);
  });
});
