import { describe, expect, it } from 'vitest';
import {
  applyPlanUpdate,
  compactPlanView,
  getNode,
  milestonesAwaitingCheck,
  nextUnexpandedMilestone,
  planCounts,
  runnableTasks,
  type PlanUpdate,
} from '../../../src/core/plan.js';

const update: PlanUpdate = {
  milestones: [
    {
      id: 'M1',
      title: 'Parse config',
      checks: ['npm test'],
      tasks: [
        { id: 'M1.T01', title: 'Add schema', checks: ['node --test'] },
        { id: 'M1.T02', title: 'Add loader', dependsOn: ['M1.T01'] },
      ],
    },
    { id: 'M2', title: 'CLI', dependsOn: ['M1'] },
  ],
};

describe('hierarchical plan', () => {
  it('builds a tree and selects runnable tasks in order, respecting deps', () => {
    const plan = applyPlanUpdate(undefined, update, 'goal');
    expect(plan.nodes.map((n) => `${n.type}:${n.id}`)).toEqual([
      'milestone:M1',
      'task:M1.T01',
      'task:M1.T02',
      'milestone:M2',
    ]);
    expect(runnableTasks(plan).map((t) => t.id)).toEqual(['M1.T01']);
    getNode(plan, 'M1.T01').status = 'done';
    expect(runnableTasks(plan).map((t) => t.id)).toEqual(['M1.T02']);
    getNode(plan, 'M1.T02').status = 'done';
    expect(milestonesAwaitingCheck(plan).map((m) => m.id)).toEqual(['M1']);
    getNode(plan, 'M1').status = 'done';
    expect(nextUnexpandedMilestone(plan)?.id).toBe('M2');
    expect(planCounts(plan)).toEqual({
      milestones: 2,
      milestonesDone: 1,
      tasks: 2,
      done: 2,
      parked: 0,
      todo: 0,
    });
  });

  it('keeps runtime fields on re-plan, adds nodes, refuses deletion', () => {
    const plan = applyPlanUpdate(undefined, update, 'goal');
    const t = getNode(plan, 'M1.T01');
    t.status = 'done';
    t.attempts = 2;
    const next = applyPlanUpdate(
      plan,
      {
        milestones: [
          {
            ...update.milestones[0],
            id: 'M1',
            title: 'Parse config v2',
            tasks: [
              { id: 'M1.T01', title: 'Add schema (renamed)' },
              { id: 'M1.T02', title: 'Add loader' },
              { id: 'M1.T03', title: 'New task' },
            ],
          },
          { id: 'M2', title: 'CLI', tasks: [{ id: 'M2.T01', title: 'Commander' }] },
        ],
        park: [{ id: 'M1.T02', reason: 'superseded by M1.T03' }],
      },
      'goal',
    );
    expect(getNode(next, 'M1.T01')).toMatchObject({
      status: 'done',
      attempts: 2,
      title: 'Add schema (renamed)',
    });
    expect(getNode(next, 'M1.T02')).toMatchObject({
      status: 'parked',
      parkedReason: 'superseded by M1.T03',
    });
    // Leaving nodes out never deletes them: they stay as they were, in place.
    const partial = applyPlanUpdate(
      next,
      { milestones: [{ id: 'M1', title: 'only one' }] },
      'goal',
    );
    expect(partial.nodes.map((n) => n.id)).toEqual(next.nodes.map((n) => n.id));
    expect(getNode(partial, 'M1').title).toBe('only one');
    expect(getNode(partial, 'M1.T01')).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('rejects bad ids, misplaced tasks, unknown deps and duplicates', () => {
    expect(() =>
      applyPlanUpdate(undefined, { milestones: [{ id: 'X', title: 'bad' }] }, 'g'),
    ).toThrow();
    expect(() =>
      applyPlanUpdate(
        undefined,
        {
          milestones: [
            { id: 'M1', title: 'mmm', tasks: [{ id: 'M2.T01', title: 'wrong parent' }] },
          ],
        },
        'g',
      ),
    ).toThrow(/must live under/);
    expect(() =>
      applyPlanUpdate(
        undefined,
        { milestones: [{ id: 'M1', title: 'mmm', dependsOn: ['M9'] }] },
        'g',
      ),
    ).toThrow(/unknown node/);
    expect(() =>
      applyPlanUpdate(
        undefined,
        {
          milestones: [
            { id: 'M1', title: 'mmm' },
            { id: 'M1', title: 'mmm' },
          ],
        },
        'g',
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      applyPlanUpdate(
        undefined,
        { milestones: [{ id: 'M1', title: 'mmm' }], park: [{ id: 'M7', reason: 'x y z' }] },
        'g',
      ),
    ).toThrow(/unknown node/);
  });

  it('parked milestones hide their tasks; compact view shows only the current milestone', () => {
    const plan = applyPlanUpdate(undefined, update, 'goal');
    const view = compactPlanView(plan, 'M1.T01');
    expect(view).toContain('[ ] M1 Parse config (0/2 tasks)');
    expect(view).toContain('M1.T01 Add schema  <- current');
    expect(view).toContain('Current task M1.T01: Add schema');
    expect(view).toContain('`node --test`');
    expect(compactPlanView(plan, undefined)).not.toContain('Current task');
    getNode(plan, 'M1').status = 'parked';
    expect(runnableTasks(plan)).toEqual([]);
  });
});

describe('normalizePlanUpdate', () => {
  it('forgives shape slips models make, then the strict schema accepts it', async () => {
    const { normalizePlanUpdate, planUpdateSchema } = await import('../../../src/core/plan.js');
    const raw = {
      milestones: [
        {
          id: 'M1',
          title: 'Core',
          description: 'the converter core',
          size: 'S',
          estimate: '2h',
          tasks: [
            {
              id: 'M1.T01',
              title: 'Headings',
              acceptance: '- # renders h1\n- ###### renders h6',
              checks: 'node --test test/headings.test.js',
              command: 'ignored',
            },
          ],
        },
      ],
    };
    expect(planUpdateSchema.safeParse(raw).success).toBe(false);
    const fixed = planUpdateSchema.parse(normalizePlanUpdate(raw));
    expect(fixed.milestones[0]?.why).toBe('the converter core');
    expect(fixed.milestones[0]?.tasks[0]).toMatchObject({
      acceptance: ['# renders h1', '###### renders h6'],
      checks: ['node --test test/headings.test.js'],
    });
  });

  it('leaves real mistakes for the schema to reject', async () => {
    const { normalizePlanUpdate, planUpdateSchema } = await import('../../../src/core/plan.js');
    expect(
      planUpdateSchema.safeParse(normalizePlanUpdate({ milestones: [{ id: 'X', title: 'bad' }] }))
        .success,
    ).toBe(false);
    expect(normalizePlanUpdate('nonsense')).toBe('nonsense');
  });
});

describe('normalizePlanUpdate: what the free-model run sent', () => {
  it('renumbers malformed task ids, follows dependsOn, maps check/kind, and parks bare ids', async () => {
    const { applyPlanUpdate, normalizePlanUpdate, planUpdateSchema } =
      await import('../../../src/core/plan.js');
    const prev = applyPlanUpdate(
      undefined,
      { milestones: [{ id: 'M3', title: 'Inline', tasks: [{ id: 'M3.T01', title: 'emphasis' }] }] },
      'g',
    );
    const raw = {
      milestones: [
        {
          id: 'M3',
          title: 'Inline',
          tasks: [
            { id: 'M3.T01', title: 'emphasis', status: 'parked' },
            { id: 'M3.T01a', title: 'star emphasis', kind: 'test', check: 'npm test' },
            { id: 'M3.T01b', title: 'underscore emphasis', kind: 'weird', dependsOn: ['M3.T01a'] },
          ],
        },
      ],
      park: ['M3.T01'],
    };
    const fixed = planUpdateSchema.parse(normalizePlanUpdate(raw, prev));
    const tasks = fixed.milestones[0]?.tasks ?? [];
    expect(tasks.map((t) => t.id)).toEqual(['M3.T01', 'M3.T02', 'M3.T03']);
    expect(tasks[1]).toMatchObject({ kind: 'tests', checks: ['npm test'] });
    expect(tasks[2]).toMatchObject({ kind: 'feature', dependsOn: ['M3.T02'] });
    expect(fixed.park).toEqual([{ id: 'M3.T01', reason: 'parked by the planner' }]);
    expect(applyPlanUpdate(prev, fixed, 'g').nodes.map((n) => [n.id, n.status])).toEqual([
      ['M3', 'todo'],
      ['M3.T01', 'parked'],
      ['M3.T02', 'todo'],
      ['M3.T03', 'todo'],
    ]);
  });
});
