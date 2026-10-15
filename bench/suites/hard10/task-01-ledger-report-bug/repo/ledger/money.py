"""Money helpers."""


def to_amount(text):
    return float(text.strip())


def fmt(amount):
    return "%.2f" % amount
