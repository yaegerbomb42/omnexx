"""Billable weight."""
import math

DIM_DIVISOR = 5000.0


def billable_weight(order):
    """(billable kg rounded up to 0.5, whether dimensional weight applied)."""
    w = order["weight_kg"]
    if w <= 0:
        raise ValueError("weight must be positive")
    l, wd, h = order["dims_cm"]
    dim = l * wd * h / DIM_DIVISOR
    return math.ceil(max(w, dim) * 2) / 2.0, dim > w


def has_hazmat(order):
    return any(it.get("hazmat") and it.get("qty", 1) > 0 for it in order.get("items", []))
