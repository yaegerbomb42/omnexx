import { describe, expect, it } from 'vitest';
import { isNoOpToolInput } from '../../../src/runtime/kernel/types.js';
import { offlineKernel } from './kernel-test-helpers.js';

describe('bug #8: no checkpoint for no-op mutating input', () => {
  it('classifies empty inputs as no-op', () => {
    expect(isNoOpToolInput(undefined)).toBe(true);
    expect(isNoOpToolInput({})).toBe(true);
    expect(isNoOpToolInput({ path: '', content: '' })).toBe(true);
    expect(isNoOpToolInput({ edits: [] })).toBe(true);
    expect(isNoOpToolInput({ path: 'a.ts', content: '' })).toBe(false);
    expect(isNoOpToolInput({ command: 'ls' })).toBe(false);
    expect(isNoOpToolInput({ force: false })).toBe(false);
  });

  it('beforeMutatingTool skips the snapshot for empty input', async () => {
    const k = offlineKernel();
    expect(await k.beforeMutatingTool('write_file', {}, 3)).toBeUndefined();
  });
});
