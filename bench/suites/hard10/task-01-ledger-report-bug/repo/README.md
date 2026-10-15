# ledger

Tiny bookkeeping tool. `python3 -m ledger report <file.csv> <YYYY-MM>` prints per-account totals
in USD for one month, one `account<TAB>total` line per account, sorted by account.
Tests: `python3 -m unittest discover -s tests`.

CSV columns: `timestamp,account,amount,currency`. Timestamps are ISO-8601 and may carry a UTC
offset (`2024-03-31T23:30:00-02:00`) or `Z`; months are UTC months. Amounts are decimal strings,
e.g. `12.10` or `-3`. Other currencies are converted to USD with the rates in `rates.py`.
