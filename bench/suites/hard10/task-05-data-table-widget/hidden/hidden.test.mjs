import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const REPO = process.env.TASK_REPO;
const { JSDOM } = createRequire(`${REPO}/package.json`)('jsdom');
const { mountTable } = await import(`${REPO}/src/table.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLUMNS = [
  { key: 'id', label: 'Order', type: 'number' },
  { key: 'customer', label: 'Customer', type: 'text' },
  { key: 'total', label: 'Total', type: 'number' },
  { key: 'placed', label: 'Placed', type: 'date' },
];
const ROWS = [
  { id: 9, customer: 'Zoë', total: 120.5, placed: '2024-03-02' },
  { id: 10, customer: 'adam', total: 9.99, placed: '2023-12-30' },
  { id: 100, customer: 'Émile', total: null, placed: '2024-01-15' },
  { id: 2, customer: 'Bea', total: 1000, placed: '' },
  { id: 33, customer: 'bea', total: 9.99, placed: '2024-01-02' },
];

function mount(rows = ROWS, columns = COLUMNS) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const root = dom.window.document.getElementById('root');
  const api = mountTable(root, { columns, rows });
  const col = (i) => [...root.querySelectorAll('tbody tr')].map((tr) => tr.children[i]?.textContent);
  const ths = () => [...root.querySelectorAll('thead th')];
  const click = (i) => ths()[i].querySelector('button').click();
  const sorts = () => ths().map((th) => th.getAttribute('aria-sort'));
  const type = (q) => {
    const input = root.querySelector('input[type="search"]');
    input.value = q;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  return { dom, root, api, col, click, sorts, type };
}

test('markup contract', () => {
  const { root, col } = mount();
  assert.equal(root.querySelectorAll('input[type="search"]').length, 1);
  assert.equal(root.querySelectorAll('table').length, 1);
  const buttons = [...root.querySelectorAll('thead th button')];
  assert.deepEqual(buttons.map((b) => b.textContent.trim()), ['Order', 'Customer', 'Total', 'Placed']);
  assert.ok(buttons.every((b) => b.getAttribute('type') === 'button'));
  assert.deepEqual(col(0), ['9', '10', '100', '2', '33']);
  assert.deepEqual(col(2), ['120.5', '9.99', '', '1000', '9.99']);
});

test('numeric sort cycles asc, desc, none with aria-sort', () => {
  const { col, click, sorts } = mount();
  assert.deepEqual(sorts(), ['none', 'none', 'none', 'none']);
  click(0);
  assert.deepEqual(col(0), ['2', '9', '10', '33', '100']);
  assert.deepEqual(sorts(), ['ascending', 'none', 'none', 'none']);
  click(0);
  assert.deepEqual(col(0), ['100', '33', '10', '9', '2']);
  assert.deepEqual(sorts(), ['descending', 'none', 'none', 'none']);
  click(0);
  assert.deepEqual(col(0), ['9', '10', '100', '2', '33']);
  assert.deepEqual(sorts(), ['none', 'none', 'none', 'none']);
});

test('empty values last both ways, stable ties', () => {
  const { col, click } = mount();
  click(2);
  assert.deepEqual(col(0), ['10', '33', '9', '2', '100']);
  click(2);
  assert.deepEqual(col(0), ['2', '9', '10', '33', '100']);
  click(3);
  assert.deepEqual(col(0), ['10', '33', '100', '9', '2']);
  click(3);
  assert.deepEqual(col(0), ['9', '100', '33', '10', '2']);
});

test('text sort is case and accent insensitive, stable', () => {
  const { col, click, sorts } = mount();
  click(1);
  assert.deepEqual(col(1), ['adam', 'Bea', 'bea', 'Émile', 'Zoë']);
  assert.deepEqual(sorts(), ['none', 'ascending', 'none', 'none']);
});

test('switching column starts ascending', () => {
  const { col, click, sorts } = mount();
  click(0);
  click(0);
  click(1);
  assert.deepEqual(sorts(), ['none', 'ascending', 'none', 'none']);
  assert.equal(col(1)[0], 'adam');
});

test('does not mutate the caller rows', () => {
  const rows = ROWS.map((r) => ({ ...r }));
  const snapshot = JSON.stringify(rows);
  const { click } = mount(rows);
  click(0);
  click(1);
  assert.equal(JSON.stringify(rows), snapshot);
});

test('debounced filter combines with sort; empty state', async () => {
  const { root, col, click, type } = mount();
  click(0);
  type('  BEA ');
  assert.equal(col(0).length, 5, 'not applied before the debounce');
  await sleep(60);
  type('bea');
  await sleep(100);
  assert.equal(col(0).length, 5, 'debounce restarts on each input');
  await sleep(120);
  assert.deepEqual(col(0), ['2', '33']);
  type('9.99');
  await sleep(200);
  assert.deepEqual(col(0), ['10', '33']);
  type('nothing-matches');
  await sleep(200);
  const trs = root.querySelectorAll('tbody tr');
  assert.equal(trs.length, 1);
  const td = trs[0].querySelector('td');
  assert.equal(td.textContent.trim(), 'No results');
  assert.equal(td.getAttribute('colspan'), '4');
  type('');
  await sleep(200);
  assert.equal(col(0).length, 5);
});

test('update keeps sort and filter; destroy cleans up', async () => {
  const { root, api, col, click, type } = mount();
  click(2);
  click(2);
  type('a');
  await sleep(200);
  api.update([
    { id: 1, customer: 'Ann', total: 5, placed: '2024-01-01' },
    { id: 2, customer: 'Bob', total: 50, placed: '2024-01-01' },
    { id: 3, customer: 'Cara', total: 7, placed: '2024-01-01' },
  ]);
  assert.deepEqual(col(0), ['3', '1']);
  type('zzz');
  api.destroy();
  assert.equal(root.childNodes.length, 0);
  await sleep(200);
  assert.equal(root.childNodes.length, 0, 'pending debounce must not re-render');
});

test('uses root.ownerDocument, not globals', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const { root } = mount([{ id: 1, customer: 'x', total: 1, placed: '2024-01-01' }]);
  assert.equal(root.querySelectorAll('tbody tr').length, 1);
});
