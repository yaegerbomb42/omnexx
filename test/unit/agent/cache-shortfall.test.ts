import { describe, expect, it } from 'vitest';
import { cacheShortfall } from '../../../src/agent/loop.js';

describe('cacheShortfall', () => {
  it('ignores the first turn and a healthy cache read', () => {
    expect(cacheShortfall(1, 0, 0)).toBeUndefined();
    expect(cacheShortfall(2, 1000, 800)).toBeUndefined();
    expect(cacheShortfall(2, 1000, 1000)).toBeUndefined();
  });

  it('names a turn that kept under 80% of the previous prompt', () => {
    expect(cacheShortfall(3, 1000, 799)).toEqual({ turn: 3, expected: 1000, got: 799 });
  });
});
