import { describe, expect, it } from 'vitest';
import { rankCommands, rankFiles, triggerAt } from '../../vscode/src/webview/suggest.js';

describe('triggerAt', () => {
  it('offers commands only for a slash at the very start', () => {
    expect(triggerAt('/com', 4)).toEqual({ kind: 'command', query: 'com' });
    expect(triggerAt('/', 1)).toEqual({ kind: 'command', query: '' });
    expect(triggerAt('fix /com', 8)).toBeNull();
    expect(triggerAt('/new thing', 10)).toBeNull();
  });

  it('offers files for an @ word before the caret, and knows where it starts', () => {
    expect(triggerAt('look at @src/pl', 15)).toEqual({ kind: 'file', query: 'src/pl', start: 8 });
    expect(triggerAt('@', 1)).toEqual({ kind: 'file', query: '', start: 0 });
    expect(triggerAt('mail me@example', 15)).toBeNull();
  });
});

describe('rankFiles', () => {
  const files = ['src/core/plan.ts', 'docs/planning.md', 'src/explain.ts', 'test/plan.test.ts'];

  it('puts exact names first, then name prefixes, substrings and in-order matches', () => {
    expect(rankFiles(files, 'plan')).toEqual([
      'src/core/plan.ts',
      'test/plan.test.ts',
      'docs/planning.md',
      'src/explain.ts',
    ]);
    expect(rankFiles(files, 'spt')).toEqual([
      'src/explain.ts',
      'src/core/plan.ts',
      'test/plan.test.ts',
    ]);
  });

  it('caps the list and shows short paths first for an empty query', () => {
    expect(rankFiles(files, '', 2)).toEqual(['src/explain.ts', 'docs/planning.md']);
  });
});

describe('rankCommands', () => {
  it('filters by prefix', () => {
    expect(rankCommands('co').map((c) => c.name)).toEqual(['compact', 'context']);
    expect(rankCommands('').length).toBeGreaterThan(8);
  });
});
