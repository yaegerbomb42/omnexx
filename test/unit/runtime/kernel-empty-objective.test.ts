import { describe, expect, it } from 'vitest';
import { objectiveFromMessages } from '../../../src/runtime/kernel/kernel.js';
import { fakeTool, offlineKernel } from './kernel-test-helpers.js';

describe('bug #22: empty kernel objective falls back to the latest user text', () => {
  it('extracts the latest user text, skipping tool results', () => {
    expect(
      objectiveFromMessages([
        { role: 'user', content: [{ type: 'text', text: 'first task' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'fix the login bug' }] },
      ]),
    ).toBe('fix the login bug');
    expect(objectiveFromMessages(undefined)).toBe('');
  });

  it('detects a new task when the goal is empty but the user text changes', async () => {
    const k = offlineKernel();
    const run = (text: string) =>
      k.planTurn({
        objective: '',
        allTools: [fakeTool('read')],
        defaultMaxTokens: 1000,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      });
    await run('task one');
    const key1 = (k as unknown as { currentTaskKey: string }).currentTaskKey;
    await run('a different task');
    const key2 = (k as unknown as { currentTaskKey: string }).currentTaskKey;
    expect(key1).toBe('task one');
    expect(key2).toBe('a different task');
  });
});
