import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { withKernelHint } from '../../../src/agent/loop.js';

describe('bug #21: kernel hint is a volatile system block, not a user message', () => {
  it('appends the hint as a volatile system block without mutating the base', () => {
    const base = [{ text: 'sys' }];
    const out = withKernelHint(base, '[kernel] tier 2');
    expect(out).toEqual([{ text: 'sys' }, { text: '[kernel] tier 2', volatile: true }]);
    expect(base).toHaveLength(1);
    expect(withKernelHint(base, undefined)).toEqual([{ text: 'sys' }]);
  });

  it('the loop no longer pushes plan.systemHint as a user message', () => {
    const src = readFileSync('src/agent/loop.ts', 'utf8');
    expect(src).not.toMatch(
      /role: 'user',\s*content: \[\{ type: 'text', text: plan\.systemHint \}\]/,
    );
  });
});
