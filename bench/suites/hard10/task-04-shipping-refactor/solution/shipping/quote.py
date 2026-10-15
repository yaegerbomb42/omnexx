"""The public quote() entry point."""
from .carriers import Shipment, base_rate
from .discounts import apply_coupon, apply_member
from .surcharges import apply_surcharges
from .weight import billable_weight, has_hazmat


def quote(order):
    """Quote shipping for an order; see README for the format. Raises ValueError."""
    billable, dimensional = billable_weight(order)
    s = Shipment(billable=billable, dest=order.get("dest", "US"), express=order.get("express", False),
                 hazmat=has_hazmat(order), drone_ok=bool(order.get("drone_ok")))
    notes = ["dimensional weight applied"] if dimensional else []
    carrier, cost, eta, rate_notes = base_rate(s)
    cost, eta, surcharge_notes = apply_surcharges(s, carrier, cost, eta)
    cost, coupon_notes = apply_coupon(order.get("coupon"), s, carrier, cost)
    cost, member_notes = apply_member(order.get("member"), cost)
    notes += rate_notes + surcharge_notes + coupon_notes + member_notes
    return {"carrier": carrier, "cost_cents": int(cost), "eta_days": eta, "notes": notes}
