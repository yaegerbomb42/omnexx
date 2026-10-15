"""Fixed conversion rates into USD."""
from decimal import Decimal

RATES = {"USD": "1", "EUR": "1.10", "GBP": "1.25", "JPY": "0.0067"}


def to_usd(amount, currency):
    return Decimal(amount) * Decimal(RATES[currency])
