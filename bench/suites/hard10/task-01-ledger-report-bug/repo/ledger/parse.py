"""CSV parsing into Entry records."""
import csv
from dataclasses import dataclass

from .money import to_amount


@dataclass(frozen=True)
class Entry:
    timestamp: str
    account: str
    amount: object  # see money.to_amount
    currency: str


def read_entries(path):
    with open(path, newline="") as fh:
        rows = list(csv.DictReader(fh))
    return [
        Entry(
            timestamp=row["timestamp"].strip(),
            account=row["account"].strip(),
            amount=to_amount(row["amount"]),
            currency=row["currency"].strip().upper(),
        )
        for row in rows
    ]
