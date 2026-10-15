"""Fixed conversion rates into USD."""

RATES = {"USD": "1", "EUR": "1.10", "GBP": "1.25", "JPY": "0.0067"}


def to_usd(amount, currency):
    return amount * float(RATES[currency])
