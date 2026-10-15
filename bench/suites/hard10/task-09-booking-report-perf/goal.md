# Task: Make the Booking Report Fast

`rooms.report.peak_report` powers the facilities dashboard. With a year of bookings (a few
hundred thousand, many repeated by the feed) it never finishes. Make it fast: a report over
300,000 bookings across a few hundred rooms must finish in a couple of seconds.

Its output must stay exactly the same for every input, including the edge cases described in the
README (duplicates, zero-length bookings, touching intervals, rooms without a listed capacity,
the `ValueError` for `end < start`). Profile it; there may be more than one hotspot. Keep the
public function and its signature. Python standard library only.

## Success Criteria

- `python3 -m unittest discover -s tests` passes
- Output is identical to the current implementation on any input
- 300,000 bookings (with duplicates) over 300 rooms finish within the hidden time limit
