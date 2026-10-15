"""Frozen copy of the original implementation: the behavior oracle (slow)."""


def peak_report(bookings, capacities):
    seen, items = [], []
    for b in bookings:
        if b["end"] < b["start"]:
            raise ValueError("booking %s ends before it starts" % b["id"])
        if b["id"] in seen:
            continue
        seen.append(b["id"])
        items.append(b)
    rooms = {}
    for b in items:
        rooms[b["room"]] = rooms.get(b["room"], []) + [b]
    report = {}
    for room, bs in rooms.items():
        points = sorted({p for b in bs for p in (b["start"], b["end"])})
        segs = []
        for a, z in zip(points, points[1:]):
            segs.append((a, z, sum(1 for b in bs if b["start"] <= a and z <= b["end"])))
        spans = []
        for a, z, n in segs:
            if n <= capacities.get(room, 1):
                continue
            if spans and spans[-1][1] == a:
                spans[-1][1] = z
            else:
                spans.append([a, z])
        report[room] = {"peak": max((n for _, _, n in segs), default=0), "overbooked": spans}
    return report
