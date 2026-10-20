import { describe, expect, it } from 'vitest';
import type { CycleSummary } from '../../../src/agent/compaction.js';
import {
  analysisIn,
  diffWorkingState,
  mergeWorkingState,
  parseWorkingState,
  renderWorkingState,
  tombstonesIn,
} from '../../../src/agent/working-state.js';

const first: CycleSummary = {
  done: ['read src/math.js', 'ran npm test: 1 failure'],
  inProgress: 'fixing add()',
  filesTouched: ['src/math.js'],
  keyFiles: ['src/math.js — add() subtracts; line 3'],
  decisions: ['fix add() in place, no new helper'],
  failed: ['swapping the args did not help'],
  lastError: 'expected 3, got -1',
  nextStep: 'replace a - b with a + b',
  openTodos: ['[in_progress] fix add'],
};

describe('working state', () => {
  it('renders deterministically and reads back what it rendered', () => {
    const text = renderWorkingState(first);
    expect(renderWorkingState(first)).toBe(text);
    expect(parseWorkingState(`goal text\n\n${text}`)).toEqual({ ...first, filesTouched: [] });
  });

  it('keeps the analysis and the tombstones word for word', () => {
    const analysis = 'Framing: add() is wrong.\n\nRoot cause: `a - b`.\n\nSteps:\n1. fix\n2. test';
    const tomb =
      "[harness] Rewound 2 pass(es) to the best tree so far because it went in circles. Don't repeat this approach.";
    const text = renderWorkingState(first, { analysis, tombstones: [tomb] });
    expect(analysisIn(text)).toBe(analysis);
    expect(text).toContain(`- ${tomb}`);
  });

  it('merges two folds: lists accumulate, files merge by path, the newer state wins', () => {
    const second: CycleSummary = {
      done: ['fixed add()', 'ran npm test: green'],
      inProgress: 'adding a test',
      filesTouched: ['test/math.test.js'],
      keyFiles: ['src/math.js — add() fixed', 'test/math.test.js — new case for add'],
      decisions: ['fix add() in place, no new helper'],
      nextStep: 'commit',
    };
    const merged = mergeWorkingState(parseWorkingState(renderWorkingState(first)), second);
    expect(merged.done).toEqual([...first.done, ...second.done]);
    expect(merged.keyFiles).toEqual([
      'src/math.js — add() fixed',
      'test/math.test.js — new case for add',
    ]);
    expect(merged.decisions).toEqual(['fix add() in place, no new helper']);
    expect(merged.failed).toEqual(first.failed);
    expect(merged).toMatchObject({ inProgress: 'adding a test', nextStep: 'commit' });
    expect(merged.lastError).toBe(first.lastError);
    expect(mergeWorkingState(undefined, second)).toBe(second);
  });

  it('finds tombstones in harness messages', () => {
    const tomb = '[harness] Rewound 1 pass(es) to the best tree so far because x.';
    expect(
      tombstonesIn([
        { role: 'user', content: [{ type: 'text', text: `${tomb}\n\nRe-think now.` }] },
        { role: 'user', content: [{ type: 'text', text: 'something else' }] },
      ]),
    ).toEqual([tomb]);
  });

  it('reads nothing from text without a working state', () => {
    expect(parseWorkingState('just a goal')).toBeUndefined();
  });
  it('diffs working states cleanly', () => {
    const prior = {
      done: ['step1'],
      decisions: ['dec1'],
      failed: ['fail1'],
      filesTouched: ['a.ts'],
      inProgress: 'working on step1',
      nextStep: 'finish step1',
    };
    const current = {
      done: ['step1', 'step2'],
      decisions: ['dec1', 'dec2'],
      failed: ['fail1'],
      filesTouched: ['a.ts', 'b.ts'],
      inProgress: 'working on step2',
      nextStep: 'test step2',
    };
    const diff = diffWorkingState(prior, current);
    expect(diff.addedDone).toEqual(['step2']);
    expect(diff.addedDecisions).toEqual(['dec2']);
    expect(diff.addedFailed).toEqual([]);
    expect(diff.inProgressChanged).toBe(true);
    expect(diff.nextStepChanged).toBe(true);
  });
});
