import { describe, expect, it } from 'vitest';
import { fakeTool, offlineKernel } from './kernel-test-helpers.js';

describe('bug #4: planTurn lazy warm receives caller skills', () => {
  it('indexes in-memory skills passed to planTurn', async () => {
    const k = offlineKernel();
    await k.planTurn({
      objective: 'write release notes',
      allTools: [fakeTool('read')],
      defaultMaxTokens: 1000,
      skills: [{ name: 'release-notes', description: 'Draft release notes from git log' }],
    });
    expect(k.catalog.has('local:skill:release-notes')).toBe(true);
  });
});
