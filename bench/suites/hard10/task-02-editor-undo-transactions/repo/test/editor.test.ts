import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../src/editor.ts';

test('insert and delete', () => {
  const ed = createEditor('hello');
  ed.insert(5, ' world');
  ed.delete(0, 1);
  assert.equal(ed.text(), 'ello world');
});

test('onChange fires per edit', () => {
  const ed = createEditor();
  const seen: string[] = [];
  ed.onChange((t) => seen.push(t));
  ed.insert(0, 'a');
  ed.insert(1, 'b');
  assert.deepEqual(seen, ['a', 'ab']);
});
