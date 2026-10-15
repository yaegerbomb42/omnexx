"""Money helpers: exact decimals, rounded half up only for display."""
from decimal import ROUND_HALF_UP, Decimal


def to_amount(text):
    return Decimal(text.strip())


def fmt(amount):
    cents = Decimal(amount).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if cents == 0:
        cents = Decimal("0.00")
    return f"{cents:.2f}"
