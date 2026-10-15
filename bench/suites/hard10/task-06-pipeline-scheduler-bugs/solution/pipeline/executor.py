"""Running one job with retries."""


def attempt(job, action):
    """Run `action` up to 1 + max_retries times; returns (ok, attempts)."""
    tries = 1 + job["max_retries"]
    for n in range(1, tries + 1):
        try:
            action()
            return True, n
        except Exception:
            continue
    return False, tries
