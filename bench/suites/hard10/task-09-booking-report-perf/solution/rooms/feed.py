"""Cleaning the raw booking feed."""


def dedupe(bookings):
    """First occurrence of each booking id, in order. Validates intervals."""
    seen = set()
    out = []
    for b in bookings:
        if b["end"] < b["start"]:
            raise ValueError("booking %s ends before it starts" % b["id"])
        if b["id"] in seen:
            continue
        seen.add(b["id"])
        out.append(b)
    return out


def by_room(bookings):
    rooms = {}
    for b in bookings:
        rooms.setdefault(b["room"], []).append(b)
    return rooms
