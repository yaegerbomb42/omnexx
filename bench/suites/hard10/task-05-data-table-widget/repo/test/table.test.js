import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountTable } from '../src/table.js';

test('renders a header and a row per item', () => {
  const { document } = new JSDOM('<div id="r"></div>').window;
  const root = document.getElementById('r');
  mountTable(root, {
    columns: [{ key: 'a', label: 'A', type: 'text' }],
    rows: [{ a: 'x' }, { a: 'y' }],
  });
  assert.equal(root.querySelectorAll('thead th').length, 1);
  assert.equal(root.querySelectorAll('tbody tr').length, 2);
});
