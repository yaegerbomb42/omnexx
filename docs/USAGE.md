# Usage, waste and task budgets

Every model call a run makes is written to `$OMNEXX_HOME/runs/<runId>/usage-ledger.jsonl` as
one JSON line. The ledger is append-only and separate from `events.jsonl`: events are for the
live feed, the ledger is the billing-shaped record that survives a crash and is cheap to sum.
`omnexx usage` reads it.

## What each call records

| Field                                      | Meaning                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `purpose`                                  | `main`, `subagent`, `retry`, `compaction`, `verification`, `reviewer`, `planner`, `judge`, `describe` or `chat` |
| `taskId`                                   | The plan task (`M1.T03`), `plan` while planning, or `untasked` for a side call with no task                     |
| `cycle`, `step`                            | The run cycle and the 1-based turn inside the current loop (`0` for side calls)                                 |
| `provider`, `model`                        | Who served the call                                                                                             |
| `usage`                                    | Raw input, cache writes/reads and output tokens                                                                 |
| `tokens`, `budgetTokens`, `usd`            | Raw total, the cache-weighted total used by caps, and the price                                                 |
| `requestHash`, `retryOf`, `errorSignature` | Fingerprint used to recognize the same failed request sent again                                                |

The provider is wrapped inside `Run`. A call made outside an attribution scope throws
`UntaggedCallError` before it reaches the network, so a new call site cannot silently escape the
ledger. `purposeForRole` maps the existing roles (`review`, `audit`, `spec_tests`, `cheap`, …)
to purposes; the worker, planner and helper loops add the task and step.

## `omnexx usage`

```console
$ omnexx usage M1.T03
task M1.T03 · 34 calls · 412.6k tokens · $0.841
  input 380.1k (cache reads 301.4k) · output 32.5k · budget-weighted 412.6k
  by purpose
    main            29 calls  361.2k   88%  $0.744
    retry            3 calls   28.4k    7%  $0.061
    compaction       2 calls   23.0k    6%  $0.036
  most expensive steps
    M1.T03 step 7       4 calls   91.2k  $0.192
    ...
  waste
    repeat reads          9   47.8k tokens saved
      src/router.ts  ×4  saved 22.1k
    same-error retries    3   28.4k tokens
      429 rate limited  ×2  19.8k
    non-shrinking folds   1   23.0k tokens
      compaction before turn 12 did not shrink (23.1k → 23.4k tokens)
    context re-sent      31  301.4k tokens read from cache
    avoidable            51.4k (12% of tokens)
```

`--json` prints the same aggregation, `--run <id>` picks a run other than the newest one, and
omitting the task shows every task in the run. A run that predates the ledger prints its
`state.json` totals with a note instead of failing.

## Measured

The attribution test runs two tasks plus planning and asserts that the ledger has exactly one
`call` record for every request the provider saw (100%, not a sample). A call made outside a
scope throws before the network, so the test would fail on the first untagged call.

The re-read guard was measured two ways.

**Read-heavy workload (deterministic).** A 350-line file read once and then re-read on twelve
turns sends 25,164 tokens of read results with the guard versus 49,548 without it: **49.2%
fewer**, against the 20% target. The pointer keeps the step and the agent's note, and the
same-range re-ask still returns the bytes, so no information is lost.

**Three real bench tasks (jimmy10 04/06/07), DeepSeek V4.1 Flash, one rep.**

| Features | Resolved | Calls | Raw input | Cache reads | Output | Guard savings |
| -------- | -------- | ----- | --------- | ----------- | ------ | ------------- |
| off      | 3/3      | 27    | 175,572   | 109,056     | 14,234 | 0             |
| on       | 3/3      | 31    | 206,482   | 39,936      | 15,902 | 205           |

Pass rate did not drop. The token total did not drop either: these tasks are read-light (one
repeat read in the whole A/B), and the guard-on run happened to take four more turns and lose
most of its prompt-cache reads, which dominates the difference. The A/B therefore shows parity,
not savings; the guard's ≥20% reduction is the read-heavy measurement above. Longer runs that
re-read files are where the ledger's `repeat_read` savings grow.

## Waste definitions

- **Repeat reads**: the re-read guard answers a read of an unchanged file, whose requested lines
  were already shown this cycle, with `"<path> is unchanged since step N; lines a-b were already
shown"` plus the note the agent attached to the first read (or the first line it saw). The
  tokens the pointer avoided are recorded as `repeat_read` waste, i.e. tokens saved. Asking for
  the exact same range twice in a row still returns the lines, because the earlier copy may have
  been trimmed. Set `[context] read_guard = false` (or `OMNEXX_CONTEXT_READ_GUARD=0`) to disable
  it for an A/B run.
- **Same-error retries**: a request with the same task and fingerprint as a failed one is
  recorded with `purpose: "retry"`, `retryOf` and the normalized `errorSignature`.
- **Non-shrinking folds**: a compaction whose `tokensAfter` is not below `tokensBefore` records
  the context that remained, so repeated expensive folds are visible.
- **Context re-sent**: cache-read input on turns after the first. It is the cost of keeping the
  conversation warm, not necessarily avoidable; it is reported separately from the avoidable
  retry/fold spend.

## Per-task budgets

```toml
[budget]
max_usd = 50
max_task_usd = 2       # warn at 80%, stop before crossing 100%
max_task_tokens = 500000
```

Env: `OMNEXX_BUDGET_MAX_TASK_USD`, `OMNEXX_BUDGET_MAX_TASK_TOKENS`.

Before every call the pre-flight adds the task's ledger totals to the worst case for the call.
At `warn_at` (default 0.8) the run emits `budget.task_warn` once per cap. A call that could
cross 100% is not made: the cycle ends with `max_task_usd` / `max_task_tokens`, its partial work
is verified and committed or rolled back as usual, then `budget.task_park` tags
`omnexx-budget-<run>-<task>-<cycle>` at `lastGreen` and parks the task with the reason. The run
moves on to the next task instead of spending the rest of the run on one. A task already done at
the cap is not parked. Planning is attributed to `plan` but is bounded by the run caps, not by a
single task's cap.
