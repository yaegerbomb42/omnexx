import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { isWritingGoal, resolveWriting } from '../../../src/core/writing.js';

describe('writing runs', () => {
  it.each([
    'Write me a book about a lighthouse keeper who finds a map.',
    'Draft a 20-page research report on solid-state batteries, with sources.',
    'Write a novel in three parts.',
    'Research and write a whitepaper on carbon markets.',
  ])('detects prose goals: %s', (goal) => {
    expect(isWritingGoal(goal)).toBe(true);
  });

  it.each([
    'Write tests for the parser module.',
    'Write a function that exports the report as CSV.',
    'Fix the bug in src/report.ts',
    'Write the API docs for the endpoint in src/server.ts',
    'Make the test suite pass.',
  ])('leaves code goals alone: %s', (goal) => {
    expect(isWritingGoal(goal)).toBe(false);
  });

  it('follows [plan] kind over detection', () => {
    expect(resolveWriting(defaultConfig({ plan: { kind: 'writing' } }), 'Fix the bug')).toBe(true);
    expect(resolveWriting(defaultConfig({ plan: { kind: 'code' } }), 'Write me a book')).toBe(
      false,
    );
    expect(resolveWriting(defaultConfig({}), 'Write me a book about bees')).toBe(true);
  });
});
