"""Carrier selection and base rates."""
from dataclasses import dataclass

REMOTE = ("AU", "NZ", "IS", "GL", "CL")
EU = ("DE", "FR", "NL", "BE", "IT", "ES", "PL", "SE", "DK", "AT")
DRONE_MAX_KG = 5


@dataclass(frozen=True)
class Shipment:
    billable: float
    dest: str
    express: bool
    hazmat: bool
    drone_ok: bool

    @property
    def domestic(self):
        return self.dest == "US"


def _freight(s):
    cost = 4500 + int(s.billable * 180)
    if not s.domestic and s.dest not in EU:
        cost += 6000
    return "freight", cost, 7 if s.domestic else 14, []


def _ground(s):
    return "ground", 1200 + int(s.billable * 95), 5, []


def _air(s):
    if s.hazmat:
        if not s.domestic:
            raise ValueError("hazmat items cannot ship internationally by air")
        carrier, cost, eta, _ = _ground(s)
        return carrier, cost, eta, ["hazmat: express downgraded to ground"]
    if s.domestic:
        return "air", 2500 + int(s.billable * 310), 1, []
    if s.dest in EU:
        return "air", 3900 + int(s.billable * 520), 3, []
    return "air", 5200 + int(s.billable * 640), 5, []


def _postal(s):
    cost = 450 if s.billable <= 0.5 else 610 if s.billable <= 1 else 880
    return "postal", cost, 4, []


def _drone_eligible(s):
    return s.drone_ok and s.domestic and not s.express and not s.hazmat and s.billable <= DRONE_MAX_KG


def base_rate(s):
    """(carrier, cost cents, eta days, notes) before surcharges and discounts."""
    if s.billable > 30:
        return _freight(s)
    if s.express or not s.domestic:
        return _air(s)
    if _drone_eligible(s):
        return "drone", 900 + int(s.billable * 150), 0, []
    if s.billable <= 2 and not s.hazmat:
        return _postal(s)
    return _ground(s)
