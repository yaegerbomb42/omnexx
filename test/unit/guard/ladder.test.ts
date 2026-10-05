import { describe, expect, it } from 'vitest';
import { planNodeSchema } from '../../../src/core/plan.js';
import { climb, LADDER } from '../../../src/guard/ladder.js';

describe('strategy ladder', () => {
  it('is an ordered list of implemented rungs only', () => {
    expect(LADDER.map((r) => r.id)).toEqual(['retry_with_evidence', 'park']);
  });
  it('no findings → no rung; a finding climbs one rung (retry → park) and parks with the reason', () => {
    const t = planNodeSchema.parse({
      id: 'M1.T01',
      title: 'task',
      type: 'task',
      parentId: 'M1',
      approachesTried: ['tried X'],
    });
    expect(climb(t, [])).toBeUndefined();
    const r = climb(t, [{ signal: 'consecutive_rejections', detail: '3 rejections in a row' }]);
    expect(r?.rung.id).toBe('park');
    expect(t).toMatchObject({
      status: 'parked',
      rung: 1,
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
