"""Month bucketing."""


def month_of(timestamp):
    """The YYYY-MM month an ISO timestamp falls in."""
    return timestamp[:7]
