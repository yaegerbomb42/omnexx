import { describe, expect, it } from 'vitest';
import { brokenChecks } from '../../../src/agent/planner.js';

const plan = (checks: string[]) => ({
  milestones: [{ id: 'M1', title: 'm', tasks: [{ id: 'M1.T01', title: 't', checks }] }],
});

describe('brokenChecks', () => {
  it('flags grep patterns that would be read as a regex by mistake', () => {
    expect(brokenChecks(plan([`grep -q "export * from './src/a.js'" index.js`]))).toEqual([
      expect.stringContaining('M1.T01: `grep -q "export * from'),
    ]);
    expect(brokenChecks(plan([`grep -q 'arr[0]' a.js`]))).toHaveLength(1);
  });

  it('accepts literal greps, intended regexes and other commands', () => {
    expect(
      brokenChecks(
        plan([
          `grep -qF "export * from './src/a.js'" index.js`,
          `grep -F -q 'arr[0]' a.js`,
          `grep -qE 'foo|bar' a.js`,
          `grep -q 'slugify' test/a.test.js`,
          `test -f index.js`,
          'npm test',
        ]),
      ),
    ).toEqual([]);
  });
});
