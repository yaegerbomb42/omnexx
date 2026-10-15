const isEmpty = (v) => v === null || v === undefined || v === '';

const COMPARE = {
  number: (a, b) => Number(a) - Number(b),
  date: (a, b) => Date.parse(a) - Date.parse(b),
  text: (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }),
};

/** A new array sorted by `column` in `dir` ('ascending' | 'descending'); empties last; stable. */
export function sortRows(rows, column, dir) {
  if (!column) return [...rows];
  const cmp = COMPARE[column.type] ?? COMPARE.text;
  const sign = dir === 'descending' ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      const a = x.row[column.key];
      const b = y.row[column.key];
      if (isEmpty(a) || isEmpty(b)) return isEmpty(a) - isEmpty(b) || x.i - y.i;
      return sign * cmp(a, b) || x.i - y.i;
    })
    .map(({ row }) => row);
}

/** Text a cell displays. */
export const cellText = (v) => (v === null || v === undefined ? '' : String(v));

/** Rows where any column's displayed text contains `query` (case-insensitive). */
export function filterRows(rows, columns, query) {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => columns.some((c) => cellText(r[c.key]).toLowerCase().includes(q)));
}
