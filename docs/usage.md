# Usage attribution, waste, and per-task budgets

Omnexx records every billed model call before the next one starts. The record is append-only:
a crash can lose the tail of the file, never rewrite or delete what was already spent.

## The ledger

`~/.omnexx/usage/ledger.jsonl` (or `$OMNEXX_HOME/usage/ledger.jsonl`) has one JSON object per line:

```json
{
  "v": 1,
  "kind": "call",
  "ts": 1792970000000,
  "runId": "r_…",
  "label": "hard10/task-01-ledger-report-bug",
  "purpose": "main",
  "taskId": "M1.T01",
  "cycle": 2,
  "turn": 4,
  "step": "c2.t4",
  "attempt": 1,
  "model": "…",
  "provider": "…",
  "usage": { "uncached": 1200, "cacheWrite": 0, "cacheRead": 8000, "output": 210 },
  "inputTokens": 9200,
  "outputTokens": 210,
  "cacheRead": 8000,
  "usd": 0.0042
}
```

- **purpose** is one of `main`, `subagent`, `retry`, `compaction`, `verification`, `reviewer`,
  `planning`, `judge`, `chat`. It is passed by the caller that knows why the call exists, never
  inferred from the prompt. `Run.addSpend` always receives one (the loop names every provider
  attempt; other callers are tagged from their role), so no billed call is untagged.
- **taskId / cycle / turn / step** locate the call. A loop updates an ordinary mutable `turn` on
  the tool context, so a tool call and the model call that follows it share a step.
- Failed retry attempts have no provider usage. They become a `kind:"call"` row with
  `purpose:"retry"` and zero tokens (so no attempt is unattributed) plus a `kind:"waste"` row with
  the normalized error signature, the number of attempts seen, and the prompt tokens re-sent. The
  one successful call keeps its parent purpose and an `attempt` count.

`omnexx usage <task>` accepts a bench label, a task id (`M1.T01`), a run id, or `chat` (or any
unique prefix). With no argument it summarizes the whole ledger. `--json` emits the report;
`--list` prints the labels in the ledger. TUI chat and its helpers share the same ledger.

## Waste heuristics

The report reconciles three things that are cheap to observe exactly, plus one derived number:

| Section                         | How it is measured                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeat reads                    | The read tool emits `read.dedup` with the bytes it did **not** return; the run copies that into a `repeat_read` waste row.                                                 |
| Retries with the same error     | `provider.retry` events are normalized (`errorSignature`: numbers, quoted values and paths become placeholders) and coalesced per signature.                               |
| Compactions that did not shrink | `context.compacted` / `context.compact_failed` events carry before/after context tokens. A fold that saves under 5% is recorded.                                           |
| Context re-sent across turns    | Derived from consecutive calls in the same `(run, task, purpose)` conversation: the overlap between the previous prompt and this one. Cache reads are reported separately. |

The re-read guard lives in `src/tools/read.ts`. When a file's hash is unchanged and the requested
lines were already shown, it returns a short note instead. `OMNEXX_READ_GUARD=off` is a benchmark
hook for a controlled A/B; it is not a user-facing setting.

```
src/a.ts is unchanged since step 4 (cycle 2); lines 1-40 were already shown.
your earlier note: "add() returns a - b; the tests expect a + b".
Use that result above, or read with refresh: true for the bytes again.
```

The note is what makes the guard safe: the model keeps the finding, not the bytes. The read cache
is per loop (one worker turn-stream) and is never shared across cycles: a new cycle's context does
not contain the old note, so suppressing bytes there would hide them. Subagents get their own
cache so their exploration never hides bytes from the parent.

## Per-task budgets

`[budget] task_max_tokens` and `task_max_usd` (or `--task-tokens` / `--task-budget`) cap one task.
The pre-flight check runs before every call and refuses a call that could cross the cap, so the
task is parked **under** 100%, never after a runaway call. At `warn_at` (default 0.8) one
`budget.task_warn` event is emitted. At the cap `Run.parkAtTaskCap` writes
`runs/<runId>/checkpoints/task-<taskId>-c<cycle>.json` with the plan node, transcript, task spend
and run spend, marks `state.taskCapHit`, and the supervisor stops with `budget-stop` (exit 3).
`omnexx resume` clears the mark; raising the caps lets the task continue from the checkpoint.
