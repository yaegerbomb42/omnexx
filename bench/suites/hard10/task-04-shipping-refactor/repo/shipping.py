"""Shipping quotes. Written in 2017, extended ever since."""
import math

_rate_cache = {}
REMOTE = ["AU", "NZ", "IS", "GL", "CL"]
EU = ["DE", "FR", "NL", "BE", "IT", "ES", "PL", "SE", "DK", "AT"]


def quote(order):
    """Quote shipping for an order.

    order: {
      "weight_kg": float, "dims_cm": [l, w, h], "dest": "US" | ISO country,
      "express": bool, "items": [{"sku": str, "qty": int, "hazmat": bool}],
      "coupon": str | None, "member": bool
    }
    returns {"carrier": str, "cost_cents": int, "eta_days": int, "notes": [str]}
    raises ValueError for orders that cannot ship.
    """
    notes = []
    w = order["weight_kg"]
    if w <= 0:
        raise ValueError("weight must be positive")
    l, wd, h = order["dims_cm"]
    dim = l * wd * h / 5000.0
    billable = max(w, dim)
    billable = math.ceil(billable * 2) / 2.0
    if dim > w:
        notes.append("dimensional weight applied")
    dest = order.get("dest", "US")
    domestic = dest == "US"
    hazmat = False
    for it in order.get("items", []):
        if it.get("hazmat") and it.get("qty", 1) > 0:
            hazmat = True
    express = order.get("express", False)
    key = (dest, express, hazmat, billable)
    if key in _rate_cache:
        carrier, cost, eta = _rate_cache[key]
    else:
        if billable > 30:
            carrier = "freight"
            cost = 4500 + int(billable * 180)
            eta = 7 if domestic else 14
            if not domestic and dest not in EU:
                cost = cost + 6000
        elif express or not domestic:
            if hazmat:
                if domestic:
                    carrier = "ground"
                    cost = 1200 + int(billable * 95)
                    eta = 5
                    notes.append("hazmat: express downgraded to ground")
                else:
                    raise ValueError("hazmat items cannot ship internationally by air")
            else:
                carrier = "air"
                if domestic:
                    cost = 2500 + int(billable * 310)
                    eta = 1
                elif dest in EU:
                    cost = 3900 + int(billable * 520)
                    eta = 3
                else:
                    cost = 5200 + int(billable * 640)
                    eta = 5
        else:
            if billable <= 2 and not hazmat:
                carrier = "postal"
                if billable <= 0.5:
                    cost = 450
                elif billable <= 1:
                    cost = 610
                else:
                    cost = 880
                eta = 4
            else:
                carrier = "ground"
                cost = 1200 + int(billable * 95)
                eta = 5
        if hazmat and carrier != "postal":
            cost = cost + 1500
        if dest in REMOTE:
            cost = int(cost * 1.25)
            eta = eta + 3
        _rate_cache[key] = (carrier, cost, eta)
    if hazmat:
        notes.append("hazmat surcharge")
    if dest in REMOTE:
        notes.append("remote area")
    coupon = (order.get("coupon") or "").strip().upper()
    if coupon:
        if coupon == "FREESHIP":
            if carrier in ("postal", "ground") and domestic and not hazmat:
                cost = 0
                notes.append("coupon FREESHIP")
            else:
                notes.append("coupon FREESHIP not applicable")
        elif coupon == "HALFAIR":
            if carrier == "air":
                cost = cost // 2
                notes.append("coupon HALFAIR")
            else:
                notes.append("coupon HALFAIR not applicable")
        else:
            notes.append("unknown coupon " + coupon)
    if order.get("member") and cost > 0:
        cost = round(cost * 0.9)
        notes.append("member discount")
    return {"carrier": carrier, "cost_cents": int(cost), "eta_days": eta, "notes": notes}
