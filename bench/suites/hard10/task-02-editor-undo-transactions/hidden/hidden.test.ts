import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createEditor } = (await import(`${process.env.TASK_REPO}/src/editor.ts`)) as {
  createEditor: (initial?: string, options?: { historyLimit?: number }) => Ed;
};
interface Ed {
  text(): string;
  insert(pos: number, str: string): void;
  delete(pos: number, len: number): void;
  onChange(fn: (t: string) => void): () => void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  transaction(fn: () => void): void;
}

test('undo and redo single edits', () => {
  const ed = createEditor('abc');
  assert.equal(ed.canUndo(), false);
  assert.equal(ed.undo(), false);
  ed.insert(3, 'def');
  ed.delete(0, 1);
  assert.equal(ed.text(), 'bcdef');
  assert.equal(ed.undo(), true);
  assert.equal(ed.text(), 'abcdef');
  assert.equal(ed.undo(), true);
  assert.equal(ed.text(), 'abc');
  assert.equal(ed.canUndo(), false);
  assert.equal(ed.canRedo(), true);
  assert.equal(ed.redo(), true);
  assert.equal(ed.redo(), true);
  assert.equal(ed.text(), 'bcdef');
  assert.equal(ed.redo(), false);
});

test('delete past the end undoes exactly', () => {
  const ed = createEditor('hello');
  ed.delete(3, 50);
  assert.equal(ed.text(), 'hel');
  ed.undo();
  assert.equal(ed.text(), 'hello');
  ed.redo();
  assert.equal(ed.text(), 'hel');
});

test('no-op edits record nothing and notify nobody', () => {
  const ed = createEditor('xy');
  let calls = 0;
  ed.onChange(() => calls++);
  ed.insert(1, '');
  ed.delete(1, 0);
  ed.delete(2, 3);
  assert.equal(calls, 0);
  assert.equal(ed.canUndo(), false);
});

test('new edit clears redo', () => {
  const ed = createEditor('');
  ed.insert(0, 'a');
  ed.insert(1, 'b');
  ed.undo();
  ed.insert(1, 'c');
  assert.equal(ed.canRedo(), false);
  assert.equal(ed.redo(), false);
  assert.equal(ed.text(), 'ac');
});

test('transaction is one step with one notification; nested folds in', () => {
  const ed = createEditor('0');
  const seen: string[] = [];
  ed.onChange((t) => seen.push(t));
  ed.transaction(() => {
    ed.insert(1, '1');
    ed.transaction(() => {
      ed.insert(2, '2');
      ed.delete(0, 1);
    });
    ed.insert(2, '3');
  });
  assert.equal(ed.text(), '123');
  assert.deepEqual(seen, ['123']);
  assert.equal(ed.undo(), true);
  assert.equal(ed.text(), '0');
  assert.equal(ed.canUndo(), false);
  assert.deepEqual(seen, ['123', '0']);
  ed.redo();
  assert.equal(ed.text(), '123');
  assert.deepEqual(seen, ['123', '0', '123']);
});

test('throwing transaction rolls back and rethrows', () => {
  const ed = createEditor('keep');
  ed.insert(4, '!');
  let calls = 0;
  ed.onChange(() => calls++);
  assert.throws(
    () =>
      ed.transaction(() => {
        ed.insert(0, 'XX');
        ed.delete(2, 2);
        throw new Error('nope');
      }),
    /nope/,
  );
  assert.equal(ed.text(), 'keep!');
  assert.equal(calls, 0);
  ed.undo();
  assert.equal(ed.text(), 'keep');
  assert.equal(ed.canUndo(), false);
});

test('empty transaction records nothing', () => {
  const ed = createEditor('a');
  let calls = 0;
  ed.onChange(() => calls++);
  ed.transaction(() => {});
  assert.equal(ed.canUndo(), false);
  assert.equal(calls, 0);
});

test('history limit drops the oldest steps', () => {
  const ed = createEditor('', { historyLimit: 3 });
  for (const ch of 'abcde') ed.insert(ed.text().length, ch);
  let n = 0;
  while (ed.undo()) n++;
  assert.equal(n, 3);
  assert.equal(ed.text(), 'ab');
  const big = createEditor('');
  for (let i = 0; i < 150; i++) big.insert(0, 'x');
  n = 0;
  while (big.undo()) n++;
  assert.equal(n, 100);
});

test('unsubscribe still works', () => {
  const ed = createEditor();
  let calls = 0;
  const off = ed.onChange(() => calls++);
  ed.insert(0, 'a');
  off();
  ed.undo();
  assert.equal(calls, 1);
});

test('random edit sequences round-trip through undo/redo', () => {
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const ed = createEditor('start', { historyLimit: 1000 });
  const states = [ed.text()];
  for (let i = 0; i < 200; i++) {
    const before = ed.text();
    if (rnd(2)) ed.insert(rnd(before.length + 2), 'xyz'.slice(0, 1 + rnd(3)));
    else ed.delete(rnd(before.length + 2), 1 + rnd(4));
    if (ed.text() !== before) states.push(ed.text());
  }
  for (let i = states.length - 1; i > 0; i--) {
    assert.equal(ed.text(), states[i]);
    assert.equal(ed.undo(), true);
  }
  assert.equal(ed.text(), 'start');
  for (let i = 1; i < states.length; i++) {
    ed.redo();
    assert.equal(ed.text(), states[i]);
  }
});
