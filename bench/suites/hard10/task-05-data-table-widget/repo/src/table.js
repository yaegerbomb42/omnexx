import { h } from './dom.js';

/**
 * Render a sortable table into `root`.
 * columns: [{ key, label, type: 'text' | 'number' | 'date' }]; rows: plain objects.
 */
export function mountTable(root, { columns, rows }) {
  const doc = root.ownerDocument;
  let sortKey = null;
  let asc = true;

  function render() {
    if (sortKey) {
      rows.sort((a, b) => (String(a[sortKey]) < String(b[sortKey]) ? -1 : 1) * (asc ? 1 : -1));
    }
    const head = h(doc, 'thead', {}, [
      h(
        doc,
        'tr',
        {},
        columns.map((c) => {
          const th = h(doc, 'th', {}, [c.label]);
          th.addEventListener('click', () => {
            asc = sortKey === c.key ? !asc : true;
            sortKey = c.key;
            render();
          });
          return th;
        }),
      ),
    ]);
    const body = h(
      doc,
      'tbody',
      {},
      rows.map((r) => h(doc, 'tr', {}, columns.map((c) => h(doc, 'td', {}, [String(r[c.key])])))),
    );
    root.replaceChildren(h(doc, 'table', {}, [head, body]));
  }

  render();
}
