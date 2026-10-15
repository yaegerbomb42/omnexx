import { h } from './dom.js';
import { cellText, filterRows, sortRows } from './sort.js';

const DEBOUNCE_MS = 150;
const NEXT = { none: 'ascending', ascending: 'descending', descending: 'none' };

/**
 * Render a sortable, filterable table into `root`.
 * columns: [{ key, label, type: 'text' | 'number' | 'date' }]; rows: plain objects.
 */
export function mountTable(root, { columns, rows }) {
  const doc = root.ownerDocument;
  let state = { rows: [...rows], sortKey: null, dir: 'none', query: '' };
  let timer = null;

  const input = h(doc, 'input', { type: 'search', 'aria-label': 'Filter rows' });
  const ths = columns.map((c) => {
    const button = h(doc, 'button', { type: 'button' }, [c.label]);
    button.addEventListener('click', () => {
      const dir = state.sortKey === c.key ? NEXT[state.dir] : 'ascending';
      state = { ...state, sortKey: dir === 'none' ? null : c.key, dir };
      render();
    });
    return h(doc, 'th', { scope: 'col', 'aria-sort': 'none' }, [button]);
  });
  const tbody = h(doc, 'tbody');
  const table = h(doc, 'table', {}, [h(doc, 'thead', {}, [h(doc, 'tr', {}, ths)]), tbody]);

  const onInput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state = { ...state, query: input.value };
      render();
    }, DEBOUNCE_MS);
  };
  input.addEventListener('input', onInput);

  function bodyRows() {
    const column = columns.find((c) => c.key === state.sortKey);
    const visible = sortRows(filterRows(state.rows, columns, state.query), column, state.dir);
    if (!visible.length) {
      return [h(doc, 'tr', {}, [h(doc, 'td', { colspan: columns.length }, ['No results'])])];
    }
    return visible.map((r) => h(doc, 'tr', {}, columns.map((c) => h(doc, 'td', {}, [cellText(r[c.key])]))));
  }

  function render() {
    columns.forEach((c, i) => {
      ths[i].setAttribute('aria-sort', c.key === state.sortKey ? state.dir : 'none');
    });
    tbody.replaceChildren(...bodyRows());
  }

  root.replaceChildren(input, table);
  render();

  return {
    update(next) {
      state = { ...state, rows: [...next] };
      render();
    },
    destroy() {
      clearTimeout(timer);
      input.removeEventListener('input', onInput);
      root.replaceChildren();
    },
  };
}
