import { describe, expect, it, vi } from 'vitest';
import { toolContext } from '../../../src/core/cycle.js';
import type { Run } from '../../../src/core/run.js';
import { configSchema } from '../../../src/config/schema.js';

// The sub-agent runner needs a real provider; this test is only about the context's timeout.
vi.mock('../../../src/agent/subagent.js', () => ({ subagentRunner: () => undefined }));

describe('the cycle tool context', () => {
  it('reads the command timeout live, so it shrinks as the run uses up its time', () => {
    let left = 600_000;
    const run = {
      worktree: '/tmp',
      exec: undefined,
      childEnv: {},
      store: {},
      events: {},
      redactor: {},
      policy: () => ({}),
      state: { cycle: 1 },
      get maxCmdTimeoutMs() {
        return left;
      },
      config: configSchema.parse({}),
      clock: { now: () => 0 },
      signal: undefined,
      judge: { enabled: () => false, breakerState: 'closed' },
    } as unknown as Run;
    const ctx = toolContext(run, new Set());
    expect(ctx.maxCmdTimeoutMs).toBe(600_000);
    left = 30_000;
    expect(ctx.maxCmdTimeoutMs).toBe(30_000);
  });
});
