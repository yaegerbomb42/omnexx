"""Hazmat and remote-area surcharges."""
from .carriers import REMOTE


def apply_surcharges(s, carrier, cost, eta):
    """(cost, eta, notes) after surcharges."""
    if s.hazmat and carrier != "postal":
        cost += 1500
    if s.dest in REMOTE:
        cost = int(cost * 1.25)
        eta += 3
    notes = (["hazmat surcharge"] if s.hazmat else []) + (["remote area"] if s.dest in REMOTE else [])
    return cost, eta, notes
