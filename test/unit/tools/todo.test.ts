import { describe, expect, it } from 'vitest';
import { todoItemsOf, todoNudge } from '../../../src/tools/todo.js';

describe('todo helpers', () => {
  it('normalizes the shapes models send', () => {
    expect(
      todoItemsOf({
        items: ['plain', { content: 'b', status: 'completed' }, { text: 'c', done: true }],
      }),
    ).toEqual([
      { text: 'plain', status: 'pending' },
      { text: 'b', status: 'done' },
      { text: 'c', status: 'done' },
    ]);
  });

  it('returns undefined for input that is not a list', () => {
    expect(todoItemsOf({ items: 'nope' })).toBeUndefined();
    expect(todoItemsOf(null)).toBeUndefined();
  });

  it('names every open item in the nudge', () => {
    const text = todoNudge([
      { text: 'add the test', status: 'pending' },
      { text: 'wire it up', status: 'in_progress' },
    ]);
    expect(text).toContain('- add the test\n- wire it up');
    expect(text).toMatch(/drop it and say why/);
  });
});
