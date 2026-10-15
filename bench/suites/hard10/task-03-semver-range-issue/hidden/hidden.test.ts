import { test } from 'node:test';
import assert from 'node:assert/strict';

const lib = (await import(`${process.env.TASK_REPO}/src/index.ts`)) as {
  compare: (a: string, b: string) => number;
  satisfies: (v: string, r: string) => boolean;
};
const { compare, satisfies } = lib;

test('SemVer 2.0.0 prerelease precedence', () => {
  const order = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.2',
    '1.0.0-alpha.10',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1-0',
    '1.0.1',
  ];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.equal(Math.sign(compare(order[i]!, order[j]!)), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
  assert.equal(compare('1.0.0-1', '1.0.0-a'), -1);
  assert.equal(compare('1.0.0-alpha+b1', '1.0.0-alpha+b2'), 0);
});

const cases: [string, string, boolean][] = [
  // caret on 0.x
  ['0.2.3', '^0.2.3', true],
  ['0.2.9', '^0.2.3', true],
  ['0.3.0', '^0.2.3', false],
  ['0.2.2', '^0.2.3', false],
  ['0.0.3', '^0.0.3', true],
  ['0.0.4', '^0.0.3', false],
  ['1.0.0', '^0.9.0', false],
  ['1.9.9', '^1.2.3', true],
  ['2.0.0', '^1.2.3', false],
  // tilde
  ['0.2.5', '~0.2.3', true],
  ['0.3.0', '~0.2.3', false],
  ['1.2.99', '~1.2.3', true],
  ['1.3.0', '~1.2.3', false],
  // prereleases are excluded unless a comparator opts in on the same tuple
  ['2.0.0-rc.1', '>=1.0.0', false],
  ['1.5.0-beta', '^1.2.3', false],
  ['1.2.3-beta.4', '^1.2.3-beta.2', true],
  ['1.2.3-beta.1', '^1.2.3-beta.2', false],
  ['1.2.4-beta.1', '^1.2.3-beta.2', false],
  ['1.9.0', '^1.2.3-beta.2', true],
  ['2.0.0-alpha', '^1.2.3-beta.2', false],
  ['1.2.3', '^1.2.3-beta.2', true],
  ['1.2.3-rc.1', '~1.2.3-beta.2', true],
  ['1.2.4', '~1.2.3-beta.2', true],
  ['1.3.0-alpha', '~1.2.3-beta.2', false],
  ['1.0.0-alpha.10', '>1.0.0-alpha.2', true],
  ['1.0.0-alpha.10', '>=1.0.0-alpha.2 <1.0.0', true],
  ['3.0.0-beta.1', '^1.0.0 || >=3.0.0-beta', true],
  ['3.0.0-beta.1', '^1.0.0 || >=3.0.0', false],
  ['3.0.0-beta.1', '3.0.0-beta.1', true],
  // plain releases unchanged
  ['1.2.3', '1.2.3', true],
  ['1.2.3', '=1.2.3', true],
  ['1.2.4', '<=1.2.3', false],
  ['1.5.0', '>=1.2.3 <2.0.0', true],
  ['2.5.0', '<2.0.0 || >=2.4.0', true],
  ['v1.2.3', '^1.0.0', true],
];

test('satisfies matches npm semver', () => {
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `satisfies(${v}, ${r})`);
});
