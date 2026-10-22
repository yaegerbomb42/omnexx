import { describe, expect, it } from 'vitest';
import { pollControl } from '../../../src/core/supervisor.js';

describe('pollControl', () => {
  it('swallows control() failures so the watcher cannot unhandle a rejection', async () => {
    const run = {
      abort: new AbortController(),
      control: async () => {
        throw new Error('control.json unreadable');
      },
    };
    await expect(pollControl(run)).resolves.toBeUndefined();
    expect(run.abort.signal.aborted).toBe(false);
  });

  it('aborts the run on stop-now', async () => {
    const run = {
      abort: new AbortController(),
      control: async () => 'stop-now' as const,
    };
    await pollControl(run);
    expect(run.abort.signal.aborted).toBe(true);
  });
});
