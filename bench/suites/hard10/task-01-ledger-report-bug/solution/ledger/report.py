"""Monthly per-account totals."""
from decimal import Decimal

from .money import fmt
from .periods import month_of
from .rates import to_usd


def monthly_totals(entries, month):
    """{account: total in USD} for entries in `month` (YYYY-MM)."""
    totals = {}
    for e in entries:
        if month_of(e.timestamp) != month:
            continue
        totals[e.account] = totals.get(e.account, Decimal(0)) + to_usd(e.amount, e.currency)
    return totals


def render(totals):
    return "\n".join(f"{acct}\t{fmt(totals[acct])}" for acct in sorted(totals))
