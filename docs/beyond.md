# Intent and beyond mode

## Intent

Your goal can be one sentence. Before planning, the planner reads the repository and records
what you actually want in `intent.md` in the run directory: the product, its users, observable
"done" conditions, the **assumptions** it made where the prompt was ambiguous, and the checks it
will add so "done" is machine-checkable. Every cycle sees the intent next to your goal, so the
agent keeps aiming at what you meant, not just what you typed.

It never stops to ask. Ambiguity becomes a written assumption; change any of them while the run
is going with `omnexx steer "<note>"` (or by typing in the interactive session).

The plan puts a **walking skeleton first**: M1 is the thinnest end-to-end version that runs and
is checked. Later milestones widen and polish it.

## Beyond mode

When every milestone is done and its checks pass, a normal agent stops. Omnexx asks the planner
for an improvement round instead, ranked against a fixed rubric: correctness hardening, test
coverage, security, performance, developer experience, accessibility/UX, observability, and
refactors that remove real risk. Every improvement task must **add or tighten a check** (a test,
a stricter lint or type rule, a benchmark threshold), so its value is verified by the gates, not
claimed. Cosmetic churn and rewrites for taste are out of bounds.

The run marks itself complete when:

- the planner finds nothing that clears the bar (it returns the plan unchanged),
- `max_rounds` improvement rounds have run, or
- less than `min_budget_left` of the money or time budget remains.

```toml
[beyond]
enabled = true          # default
max_rounds = 3          # default
min_budget_left = 0.2   # default; never below twice budget.wrapup_reserve
```

The feed shows it: `✓ intent …`, `· beyond goal met; planning improvement round 1/3`,
`✓ beyond round 1: 4 new nodes`, and finally `· beyond round 2: nothing worth doing; wrapping up`.
