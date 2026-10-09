import { describe, expect, it } from 'vitest';
import { splitDepth } from '../../../src/core/supervisor.js';
import { applyPlanUpdate } from '../../../src/core/plan.js';

describe('splitDepth', () => {
  it('counts how many splits produced a task', () => {
    const plan = applyPlanUpdate(
      undefined,
      {
        milestones: [
          {
            id: 'M1',
            title: 'mile',
            tasks: ['T01', 'T02', 'T03', 'T04'].map((t) => ({ id: `M1.${t}`, title: `task ${t}` })),
          },
        ],
      },
      'g',
    );
    const node = (id: string) => plan.nodes.find((n) => n.id === id);
    const t1 = node('M1.T01');
    const t2 = node('M1.T02');
    if (t1) t1.splitInto = ['M1.T02'];
    if (t2) t2.splitInto = ['M1.T03'];
    expect(splitDepth(plan, 'M1.T01')).toBe(0);
    expect(splitDepth(plan, 'M1.T02')).toBe(1);
    expect(splitDepth(plan, 'M1.T03')).toBe(2);
    expect(splitDepth(plan, 'M1.T04')).toBe(0);
  });
});
