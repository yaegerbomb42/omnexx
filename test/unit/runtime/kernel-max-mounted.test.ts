import { describe, expect, it } from 'vitest';
import { resolveMaxMounted } from '../../../src/runtime/kernel/kernel.js';
import { offlineKernel } from './kernel-test-helpers.js';

describe('bug #12: single max-mounted knob', () => {
  it('maxMounted wins; maxMountedTools is only a fallback alias', () => {
    expect(resolveMaxMounted({ maxMounted: 3, maxMountedTools: 9 })).toBe(3);
    expect(resolveMaxMounted({ maxMountedTools: 9 })).toBe(9);
    expect(resolveMaxMounted({})).toBe(8);
  });

  it('router profile and catalog use the same cap', () => {
    const k = offlineKernel({ maxMounted: 3, maxMountedTools: 12 });
    expect((k as unknown as { profile: { maxMountedTools: number } }).profile.maxMountedTools).toBe(
      3,
    );
  });
});
