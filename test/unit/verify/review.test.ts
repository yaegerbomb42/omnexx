import { describe, expect, it } from 'vitest';
import { coerceReview } from '../../../src/verify/review.js';

describe('coerceReview', () => {
  it('maps a model’s own field names and severities onto the schema', () => {
    const r = coerceReview({
      summary: 'two gaps',
      findings: [
        { finding: 'CSV export ignores quotes', severity: 'High', path: 'src/csv.js' },
        { issue: 'no tests for empty input', level: 'critical', suggestion: 'add one' },
        { finding: 'function exists', status: 'confirmed' },
        'docs missing',
        { severity: 'major' },
      ],
    });
    expect(r?.findings).toEqual([
      { severity: 'major', file: 'src/csv.js', problem: 'CSV export ignores quotes', fix: '' },
      { severity: 'blocker', file: '', problem: 'no tests for empty input', fix: 'add one' },
      { severity: 'minor', file: '', problem: 'docs missing', fix: '' },
    ]);
    expect(r?.summary).toBe('two gaps');
  });

  it('accepts other list names, caps the list, and rejects unusable answers', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ problem: `gap ${i}`, severity: 'minor' }));
    expect(coerceReview({ gaps: many })?.findings).toHaveLength(20);
    expect(coerceReview({ issues: [] })).toEqual({ findings: [], summary: '' });
    expect(coerceReview({ verdict: 'fine' })).toBeUndefined();
    expect(coerceReview({ findings: [], summary: 'sound' })).toEqual({
      findings: [],
      summary: 'sound',
    });
    expect(coerceReview('nope')).toBeUndefined();
  });
});
