"""Peak usage and overbooking per room."""
from .feed import by_room, dedupe
from .occupancy import segments


def _overbooked(segs, capacity):
    spans = []
    for a, z, n in segs:
        if n <= capacity:
            continue
        if spans and spans[-1][1] == a:
            spans[-1][1] = z
        else:
            spans.append([a, z])
    return spans


def peak_report(bookings, capacities):
    report = {}
    for room, items in by_room(dedupe(bookings)).items():
        segs = segments(items)
        report[room] = {
            "peak": max((n for _, _, n in segs), default=0),
            "overbooked": _overbooked(segs, capacities.get(room, 1)),
        }
    return report
