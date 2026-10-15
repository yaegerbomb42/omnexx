# Task: Fix Wrong Monthly Totals in the Ledger Report

Users report that `python3 -m ledger report data.csv 2024-03` prints wrong totals for some
accounts. Two examples from the bug report:

- An account with many small entries (`0.10`, `0.20`, `0.70`, ...) sometimes ends a cent off,
  and totals like `-0.00` appear when entries cancel out.
- Entries timestamped near midnight with a UTC offset (for example
  `2024-03-31T23:30:00-02:00`, which is April 1st in UTC) land in the wrong month.

Find and fix the root causes (there may be more than one, in more than one module). The README
describes the intended behavior. Keep the CLI and the public functions
(`ledger.parse.read_entries`, `ledger.report.monthly_totals`, `ledger.report.render`) working
with the same arguments and output format.

## Success Criteria

- `python3 -m unittest discover -s tests` passes
- Totals are exact: no floating-point drift, rounded to cents half-up only when printed, and
  never printed as `-0.00`
- Entries are bucketed by their UTC month, for timestamps with offsets, with `Z`, and across a
  year boundary
