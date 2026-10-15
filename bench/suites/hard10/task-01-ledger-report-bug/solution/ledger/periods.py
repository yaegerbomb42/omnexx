"""Month bucketing."""
from datetime import datetime, timezone


def month_of(timestamp):
    """The YYYY-MM UTC month an ISO timestamp falls in (naive timestamps count as UTC)."""
    dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m")
