"""Coupons and the member discount."""


def apply_coupon(code, s, carrier, cost):
    """(cost, notes) after a coupon code."""
    coupon = (code or "").strip().upper()
    if not coupon:
        return cost, []
    if coupon == "FREESHIP":
        if carrier in ("postal", "ground") and s.domestic and not s.hazmat:
            return 0, ["coupon FREESHIP"]
        return cost, ["coupon FREESHIP not applicable"]
    if coupon == "HALFAIR":
        if carrier == "air":
            return cost // 2, ["coupon HALFAIR"]
        return cost, ["coupon HALFAIR not applicable"]
    return cost, ["unknown coupon " + coupon]


def apply_member(member, cost):
    if member and cost > 0:
        return round(cost * 0.9), ["member discount"]
    return cost, []
