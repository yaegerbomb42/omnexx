import { describe, expect, it } from 'vitest';
import { ExecutionCallStack } from '../../../src/agent/call-stack.js';

describe('ExecutionCallStack', () => {
  it('manages stack frames and raises structured traps', () => {
    const stack = new ExecutionCallStack();
    expect(stack.current()).toBeUndefined();

    stack.push({
      id: 'frame-1',
      taskId: 'M1.T01',
      title: 'Implement database connection',
      assumptions: ['SQLite is available'],
      dependencies: [],
      pushedAtCycle: 1,
      status: 'active',
    });

    expect(stack.current()?.title).toBe('Implement database connection');
    expect(stack.current()?.status).toBe('active');

    const trapped = stack.raiseTrap(
      'ENVIRONMENT_INCOMPATIBLE',
      'Database driver requires C++ compilation toolchain',
      3,
    );

    expect(trapped?.status).toBe('trapped');
    expect(trapped?.trap?.kind).toBe('ENVIRONMENT_INCOMPATIBLE');
    expect(trapped?.trap?.turn).toBe(3);

    const popped = stack.pop();
    expect(popped?.id).toBe('frame-1');
    expect(stack.current()).toBeUndefined();
  });
});
