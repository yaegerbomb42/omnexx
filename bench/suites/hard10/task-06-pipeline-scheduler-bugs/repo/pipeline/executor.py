"""Running one job with retries."""


def attempt(job, action):
    """Run `action` with retries; returns (ok, attempts)."""
    attempts = 0
    while attempts < job["max_retries"]:
        attempts += 1
        try:
            action()
            return True, attempts
        except Exception:
            continue
    if attempts == 0:
        try:
            action()
            return True, 1
        except Exception:
            return False, 1
    return False, attempts
