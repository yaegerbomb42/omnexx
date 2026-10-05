import { describe, expect, it } from 'vitest';
import { planNodeSchema } from '../../../src/core/plan.js';
import { climb, LADDER } from '../../../src/guard/ladder.js';

describe('strategy ladder', () => {
  it('is an ordered list of implemented rungs only', () => {
    expect(LADDER.map((r) => r.id)).toEqual([
      'retry_with_evidence',
      'escalate_model',
      'replan_task',
      'park',
    ]);
  });
  it('no findings → no rung; findings climb retry → escalate (counters reset) → replan → park with the reason', () => {
    const t = planNodeSchema.parse({
      id: 'M1.T01',
      title: 'task',
      type: 'task',
      parentId: 'M1',
      approachesTried: ['tried X'],
    });
    expect(climb(t, [])).toBeUndefined();
    t.consecutiveRejections = 3;
    t.failureSignatures = ['s', 's', 's'];
    const e = climb(t, [{ signal: 'consecutive_rejections', detail: '3 rejections in a row' }]);
    expect(e?.rung.id).toBe('escalate_model');
    expect(t).toMatchObject({
      escalated: true,
      consecutiveRejections: 0,
      failureSignatures: [],
      status: 'todo',
      approachesTried: ['tried X'],
    });
    expect(climb(t, [{ signal: 'consecutive_rejections', detail: 'x' }])?.rung.id).toBe(
      'replan_task',
    );
    expect(t.status).toBe('todo');
    const r = climb(t, [{ signal: 'consecutive_rejections', detail: '3 rejections in a row' }]);
    expect(r?.rung.id).toBe('park');
    expect(t).toMatchObject({
      status: 'parked',
      rung: 3,
      parkedReason: 'consecutive_rejections: 3 rejections in a row',
    });
  });
  it('retry rung adds a do-not-repeat instruction', () => {
    const t = planNodeSchema.parse({
      id: 'M1.T01',
      title: 'task',
      type: 'task',
      parentId: 'M1',
      approachesTried: ['tried X'],
    });
    expect(LADDER[0]?.apply(t, [])).toBe('retry with evidence');
    expect(t.evidence.at(-1)).toBe('Do not repeat this approach: tried X');
  });
});
