# Architecture

One supervisor per run, one agent loop at a time. The supervisor is deterministic TypeScript; only the agent loop, the planner and a few budget-gated helper calls talk to a model.

```
omnexx run ──(detach)──> omnexx supervise <runId>   (one per run, lock + heartbeat)
                            ├─ planner        cycle 0, expansions, milestone re-plans (read-only tools + write_plan)
                            ├─ cycle          ACT → VERIFY → COMMIT | ROLLBACK → RECORD → GUARD
                            ├─ gates          child processes, process-group timeouts, parsed output, no model
                            ├─ git            worktree on omnexx/<runId>, trailer commits, reset to lastGreen
                            ├─ guards         budgets, stuck signals, ladder, wrap-up, control requests
                            ├─ judge          optional, advisory (none | nimble | llm), fail-open
                            └─ events.jsonl, heartbeat.json, ntfy, REPORT.md
```

## State on disk

`$OMNEXX_HOME/runs/<runId>/` (outside the repo): `goal.md`, `plan.json` (hierarchical), `progress.md`, `notes.json`/`notes.md`, `codemap.json`/`codemap.md`, `state.json` (phase machine, atomic writes), `events.jsonl`, `heartbeat.json`, `control.json`, `lock`, `logs/`, `rejected/`, `salvage/`, `REPORT.md`. The worktree lives at `$OMNEXX_HOME/worktrees/<repo>-<runId>`.

## The phase machine

`init → planning → select → act → verify → commit|rollback → record → guard → select … → wrapup → done`

Every transition is written to `state.json` (tmp + fsync + rename) **before** that phase's side effects, so a crash restarts the current phase:

| Crashed in        | On resume                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `act`             | Dirty tree saved to `salvage/<cycle>.patch`, reset to `lastGreen`, ACT re-runs. The task's attempt count doesn't go up.                                      |
| `verify`          | Gates re-run on the tree as it is.                                                                                                                           |
| `commit`          | If HEAD is already a commit with this run's and cycle's trailers, it's adopted; otherwise the pending verdict is committed. Never two commits for one cycle. |
| `rollback`        | Rollback again (idempotent).                                                                                                                                 |
| `record`          | Skipped if `recordedCycle` already equals this cycle.                                                                                                        |
| `guard`, `select` | Re-evaluated.                                                                                                                                                |

The lock (`{pid, host, bootId}`, created with `O_EXCL`) is stale when the pid is gone or the boot id changed; takeovers are serialized so exactly one supervisor wins. `omnexx resume --all` (what the service runs) starts one supervisor per interrupted run.

## The mechanisms

| #   | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                  | Events                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **Fresh context every cycle**, from compact files only: system prompt, codemap, goal, lessons (cached prefix, breakpoint), then a state message with the compact plan view, progress tail and task evidence (breakpoint), then the turns (moving breakpoint). Lessons are snapshotted at cycle start so the prefix is byte-identical within a cycle.                                                                                                           | `src/agent/context.ts`, `src/core/cycle.ts`                            | `cycle.context`, `turn` (tokens by class, `cacheReadShare`)       |
| 2   | **Lessons file** via `remember` (typed, dated, capped at ~1.5k tokens; add/replace/remove by id; full means replace or remove). Per-task `approachesTried`, failure signatures and evidence feed retries. Milestone-boundary consolidation applies only if shorter and every `env`/`command` fact survives.                                                                                                                                                    | `src/core/notes.ts`, `src/tools/remember.ts`, `src/core/milestones.ts` | `notes.update`, `notes.consolidation`                             |
| 3   | **Commands are the judge.** Baseline at the start commit; ratchet per gate; anti-cheat on the diff; task checks decide "done"; rollback saves `rejected/<cycle>.patch`. The agent can't mark anything done.                                                                                                                                                                                                                                                    | `src/verify/*`, `src/core/cycle.ts`                                    | `baseline`, `verify.gates`, `verify.result`, `commit`, `rollback` |
| 4   | **Stuck detection + ladder.** Consecutive rejections, repeated signature, cycles-per-task, A→B→A oscillation by blob hash (rejects within one cycle). Ladder: retry with evidence → escalate to the planner model (stuck counters restart) → the planner splits it into 2–4 smaller tasks (the original is done when they are; dependents are rewired) → park; run-level stop-and-ask when nothing is runnable or there's been no progress for 8 cycles / 3 h. | `src/guard/stuck.ts`, `src/guard/ladder.ts`, `src/core/supervisor.ts`  | `stuck.signal`, `ladder.rung`, `task.parked`                      |
| 5   | **Budgets with pre-flight.** Before each call: worst case = estimated input × the highest input rate + `max_tokens` × output rate. Per-cycle turns/tokens, run USD/hours/cycles, 80% warning, wrap-up reserve.                                                                                                                                                                                                                                                 | `src/guard/budget.ts`, `src/agent/loop.ts`                             | `budget.preflight_stop`, `budget.warn`, `budget.stop`             |
| 6   | **Crash-safe resume.** Above. Plus `--detach`, heartbeat every 15 s, control file polled between turns, `stop --now` aborts the in-flight call.                                                                                                                                                                                                                                                                                                                | `src/core/supervisor.ts`, `src/core/lock.ts`, `src/daemon/*`           | `run.resume`, `reconcile.*`, `control.*`                          |
| 7   | **Hierarchical plan + codemap.** Milestones first; the next one or two expanded; a milestone is done only when its tasks are done **and** its checks pass on `lastGreen` (otherwise it's re-planned, then parked). Codemap updated only for files each commit touched.                                                                                                                                                                                         | `src/core/plan.ts`, `src/agent/planner.ts`, `src/agent/codemap.ts`     | `planner.start`, `plan.written`, `milestone.*`, `codemap.updated` |
| 8   | **Checkpoints + report.** Tag `omnexx/<runId>/<milestone>` per finished milestone; `REPORT.md` with eight sections, written at every terminal outcome.                                                                                                                                                                                                                                                                                                         | `src/core/milestones.ts`, `src/core/report.ts`                         | `milestone.done`, `run.finish`                                    |

The judge (advisory) and the worker lifecycle are described in [judge.md](judge.md) and [workers.md](workers.md).

## Metrics for the M4 benchmark

`turn` events carry tokens split into uncached / cache write / cache read / output, cost and cache-read share. `omnexx status --json` reports totals, `cacheHitRatio`, `usdPerAcceptedCommit`, turns, model calls, active time, and judge agreement with the rules.
