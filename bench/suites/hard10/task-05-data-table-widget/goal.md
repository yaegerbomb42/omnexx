# Task: Make the Data Table Widget Production-Ready

`mountTable(root, { columns, rows })` in `src/table.js` renders a table, but sorting is broken
(numbers and dates sort as strings, it reorders the caller's array) and it lacks features the
dashboard needs. Rework it (keep it dependency-free; split files as you see fit) to meet this
contract. Tests run in jsdom; the widget must use only `root.ownerDocument`, never the global
`document`/`window`.

**Markup.** `root` contains exactly one `<input type="search">` and one `<table>` with a
`<thead>` (one `<tr>` with one `<th>` per column, in order) and a `<tbody>`. Each `<th>` contains
a `<button type="button">` whose text is the column label. Each data row is a `<tr>` in the
`<tbody>` with one `<td>` per column whose text is the cell value (`null`/`undefined` render as
empty text; numbers via `String(n)`).

**Sorting.** Clicking a column's button cycles that column through ascending, descending, then
unsorted (original order); clicking a different column starts it at ascending. The sorted
`<th>` has `aria-sort="ascending"` or `"descending"`; every other `<th>` has `aria-sort="none"`
(all `none` when unsorted). Compare by column `type`: `number` numerically, `date` (ISO
`YYYY-MM-DD` strings) chronologically, `text` case- and accent-insensitively
(`localeCompare` with `{ sensitivity: 'base' }`). Empty values (`null`, `undefined`, `''`) always
sort last, in both directions. Sorting is stable. Never mutate the `rows` array passed in.

**Filtering.** Typing in the search input filters rows to those where any cell's displayed text
contains the query, case-insensitively (trimmed; an empty query shows all rows). Apply it 150 ms
after the last `input` event (debounce). Filtering and sorting combine. When no row matches, the
`<tbody>` holds one row with one `<td>` that spans all columns (`colspan`) and reads
`No results`.

**API.** `mountTable` returns `{ update(rows), destroy() }`. `update` replaces the data and keeps
the current sort and filter. `destroy` empties `root` and cancels any pending debounce.

## Success Criteria

- `npm test` passes, with tests for the new behavior
- The widget meets the contract above in jsdom
