# pipeline

Runs a DAG of jobs in-process. Tests: `python3 -m unittest discover -s tests`.

```python
from pipeline import run, CycleError
results = run(specs, actions)
```

- `specs`: list of `{"name": str, "deps": [names], "priority": int = 0, "max_retries": int = 0}`.
- `actions`: `{name: callable}`; a job fails when its callable raises.
- Returns `{name: {"status": "ok" | "failed" | "skipped", "attempts": int}}` for every job.

Semantics:

- A job runs only after all of its deps finished with `ok`. If any dep is `failed` or `skipped`,
  the job is `skipped` (0 attempts) and never called.
- Among jobs that are ready at the same time, higher `priority` runs first, ties by name.
- A failing job is retried up to `max_retries` more times (so at most `1 + max_retries`
  attempts) before it is `failed`. `attempts` counts calls.
- Unknown deps raise `ValueError`. Cycles raise `CycleError` (a `ValueError`) whose message
  lists the jobs in the cycle.
