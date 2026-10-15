"""Occupancy over time for one room."""


def segments(bookings):
    """[(start, end, active_count)] for each span between consecutive boundaries."""
    points = sorted({p for b in bookings for p in (b["start"], b["end"])})
    out = []
    for a, z in zip(points, points[1:]):
        active = sum(1 for b in bookings if b["start"] <= a and z <= b["end"])
        out.append((a, z, active))
    return out
