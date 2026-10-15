# rooms

Room-booking analytics for the facilities dashboard. Tests:
`python3 -m unittest discover -s tests`.

`rooms.report.peak_report(bookings, capacities)`:

- `bookings`: list of `{"id": str, "room": str, "start": int, "end": int}` (minutes since epoch;
  intervals are half-open `[start, end)`). The feed repeats bookings; only the first occurrence
  of an `id` counts. `end < start` raises `ValueError`; zero-length bookings occupy nothing.
- `capacities`: `{room: int}`; rooms not listed have capacity 1.
- Returns `{room: {"peak": int, "overbooked": [[start, end], ...]}}` for every room that appears
  in the (deduplicated) bookings: the maximum number of simultaneous bookings, and the maximal
  intervals during which more bookings are active than the capacity, sorted by start.
