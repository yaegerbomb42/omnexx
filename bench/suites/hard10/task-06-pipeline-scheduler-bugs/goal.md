# Task: Fix the Pipeline Scheduler

The in-process job runner in `pipeline/` misbehaves in production. Reports from the on-call log:

- "Our build graph has a diamond (`lint` and `test` both depend on `deps`, `package` depends on
  both) and `run()` rejects it with `CycleError`."
- "`upload` failed for good, and `notify`, which depends on it, still ran."
- "A flaky job with `max_retries: 2` succeeded on its third try in my terminal, but the runner
  marked it failed after two attempts."
- "Jobs with `priority: 10` run after `priority: 0` ones."

The intended semantics are in the README. Find the root causes across the package and fix them;
keep the public API (`pipeline.run`, `pipeline.CycleError`) and the result format. Add regression
tests for each report.

## Success Criteria

- `python3 -m unittest discover -s tests` passes
- The runner follows every rule in the README: real cycles (including self-loops) are still
  rejected with `CycleError`, diamonds are accepted, dependents of failed or skipped jobs are
  skipped transitively and never called, retries and attempts count correctly, and ready jobs
  run by priority (high first) then name
