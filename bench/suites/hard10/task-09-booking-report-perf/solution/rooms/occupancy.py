"""Occupancy over time for one room."""
from collections import Counter


def segments(bookings):
    """[(start, end, active_count)] for each span between consecutive boundaries (sweep line)."""
    delta = Counter()
    for b in bookings:
        delta[b["start"]] += 1
        delta[b["end"]] -= 1
    points = sorted({p for b in bookings for p in (b["start"], b["end"])})
    out = []
    active = 0
    for a, z in zip(points, points[1:]):
        active += delta[a]
        out.append((a, z, active))
    return out
