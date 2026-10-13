# Task: Add CSV Export

Add `toCsv(rows, columns)` to `src/csv.js` and use it in `src/export.js` so `exportUsers(users)`
returns CSV with a header row `id,name,email`.

- Fields containing a comma, a double quote or a newline are wrapped in double quotes, with inner quotes doubled (RFC 4180)
- `null`/`undefined` become empty fields; lines end with `\r\n`; no trailing line break after the last row

## Success Criteria

- `npm test` passes with tests for quoting and empty values
