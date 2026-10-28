# Autonomous run time: research and improvement plan

Started 2026-10-28. Living document: append to the log in §9 instead of rewriting history, and
tick roadmap boxes as items land. Everything here is about two questions:

1. **How long can omnexx keep working on one task without a human?**
2. **When a person asks for 2 hours, does omnexx actually spend 2 hours well?**

They are different problems. The first is reliability. The second is budgeting: sticking to the
asked-for time **and** converting that time into better work.

## 0. Tracked work

| Item                                            | State                             | Where                                                   |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| VS Code model chip opens Settings → Your models | open PR                           | [#353](https://github.com/yaegerbomb42/omnexx/pull/353) |
| Duplicate declarations blocking `main` builds   | in #353                           | `src/cli/program.ts`, `src/core/supervisor.ts`          |
| Run-time budget research (this file)            | round 1 done, no measurements yet | `autonomous_improvements.md`                            |

## 1. Vocabulary

- **Adherence** — the run returns a result within the time the person asked for.
- **Overrun** — `elapsed / budget - 1`, measured on the same clock the budget uses.
- **Productive use** — extra budget buys better work. Concretely: quality should improve as the
  budget grows. If a 1 h run and a 4 h run score the same, the extra time bought nothing.
- **Useful time** — active minutes that produced accepted work (a commit, a passing check, new
  evidence), not minutes spent retrying, re-reading or padding.

Adherence is a harness problem and mostly solvable. Productive use is an agent-policy problem and
is still open in the literature (§3). The plan below treats them separately on purpose.

## 2. What omnexx does today

### 2.1 The mechanisms that exist

| Mechanism                               | Default                                 | Where                                        | Effect                                                                                                     |
| --------------------------------------- | --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Time choice (`5m … 8h`, `unlimited`)    | `2h`                                    | `src/core/agent-levels.ts`                   | maps to `budget.max_hours`; `unlimited` is 8,760 h                                                         |
| `max_hours`                             | 24                                      | `src/config/schema.ts`                       | run-level wall-clock cap, checked at cycle boundaries **and** mid-cycle                                    |
| `max_cycles` / turns / tokens per cycle | 300 / 40 / 400k                         | `src/config/schema.ts`                       | other ceilings that often bind before time                                                                 |
| `max_usd`, `max_usd_per_day`            | 50 / 50                                 | `src/config/schema.ts`                       | spend caps with a rolling-24 h pause                                                                       |
| `warn_at`, `wrapup_reserve`             | 0.8, 0.08                               | `src/guard/budget.ts`                        | warn, then treat the last 8% as reserve                                                                    |
| Per-task caps                           | off                                     | `src/guard/task-governor.ts`                 | park one runaway task, keep the run                                                                        |
| Active-time accounting                  | —                                       | `src/core/run.ts` (`elapsedMs`)              | persisted across restarts; provider waits and daily-cap pauses are excluded                                |
| Mid-cycle deadline                      | —                                       | `src/core/supervisor.ts` watchdog            | aborts the cycle at `max_hours`, verifies and keeps partial work                                           |
| Command clamp                           | —                                       | `src/core/run.ts` (`maxCmdTimeoutMs`)        | a command's timeout never exceeds the run's remaining time + 60 s                                          |
| Planner brief                           | —                                       | `src/core/agent-levels.ts` (`timeBrief`)     | one sentence: "the user wants this done in about 2h; size the plan so it fits"                             |
| Plan depth by time                      | —                                       | `taskEffortProfile`                          | ≥4 h at effort ≥6 forces milestone planning                                                                |
| `beyond` rounds                         | —                                       | `src/core/supervisor.ts` (`beyondAllowed`)   | autonomous runs keep adding work while budget remains                                                      |
| Stuck / idle guards                     | 3 h, 12 cycles, 45 m silence, 15 m idle | `src/config/schema.ts`, `src/guard/stuck.ts` | park or end rather than loop                                                                               |
| Run estimate                            | —                                       | `src/core/run-estimate.ts`                   | median wall time / tokens / USD of 5 similar past runs; shown in the CLI and TUI, never given to the model |

The pieces are sound: the clock is honest across restarts, waits are excluded, long commands are
clamped, and partial work is verified at the deadline. The gap is not the cap. It is that the cap
is almost **invisible to the model**.

### 2.2 Gaps this creates

- **G1 — No clock in context.** The model is told "about 2h" once, at planning time. Nothing
  reports elapsed or remaining time afterwards. `timeBrief` is a static string.
- **G2 — No action-duration feedback.** `src/agent/loop.ts` measures every tool call (`ms` in the
  `tool.call` event) but does not put that duration, or the time left, into the tool result the
  model reads. The model cannot calibrate "how long does a test run take here".
- **G3 — Enforcement is partial.** Bash is clamped; browser waits, dev servers, subagent work and
  model calls are not all bounded by the run deadline, and nothing _refuses_ an action whose
  declared timeout exceeds the time left.
- **G4 — The reserve is a stop line, not a work slice.** `inWrapup` finalizes and exits as soon as
  the last 8% is entered; autonomous `beyond` rounds stop even earlier, at 16%
  (`wrapup_reserve * 2`). That time is budgeted but never spent.
- **G5 — No allocation.** The planner gets one total. Nothing divides it across milestones or
  tasks, re-plans when a task eats 3× its share, or pulls work forward when the run is ahead.
  `PlanNode.size` is `S | M | L` but has no minutes attached.
- **G6 — Other caps bind first on long runs.** 300 cycles is the practical ceiling for a 24 h run
  (4.8 min/cycle) and definitely for a multi-day one; per-cycle tokens (400k) can also bind.
- **G7 — "Unlimited" is not unlimited.** It only raises `max_hours`; `max_cycles`, idle and
  no-progress guards still end the run.
- **G8 — Time is not part of the value model.** Beyond rounds, escalation and the router weigh
  money and cycles, but not "how many useful minutes are left".

## 3. What other harnesses do

| Harness                    | Duration model                                                | Notable mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code**            | No wall-clock stop; the subscription window is the real limit | `--max-turns`, `--max-budget-usd`; background commands capped at 30 m, extendable to 2 h ([guide](https://reveneau.com/guides/claude-code-agent-costs/timeouts-retries-and-cleanup-for-unattended-runs)); self-hosted runners can `--kill-session-after-min` as a stuck-session safety net. Third-party deadline hooks warn at 80% and force the agent to finalize at 100% rather than killing it ([docs](https://code.claude.com/docs/en/self-hosted-environments-reference), [hook example](https://github.com/kochetkov-ma/claude-brewcode/blob/main/brewtools/skills/agent-deadline-setup/assets/agent-deadline-guard.mjs)) |
| **Codex**                  | Usage windows, not a per-task timer                           | Long tasks commonly hit the 5 h allowance; users ask for pause/resume and build external orchestrators to survive it ([community thread](https://community.openai.com/t/feature-request-safe-pause-resume-for-long-running-codex-tasks-before-the-5-hour-limit/1393133), [issue](https://github.com/openai/codex/issues/36596))                                                                                                                                                                                                                                                                                                 |
| **OpenHands**              | Per-conversation iteration cap, plus session time limits      | `MAX_ITERATIONS` ends the conversation with a runtime error; docs list long-running sessions as a known limitation ([issue](https://github.com/OpenHands/OpenHands/issues/9426), [guidelines](https://docs.openhands.dev/openhands/usage/essential-guidelines/when-to-use-openhands))                                                                                                                                                                                                                                                                                                                                           |
| **Devin**                  | Agent Compute Units, per-message cap                          | Idle sessions sleep (30 min default, 5 min for API), a per-message ACU cap puts the session to sleep instead of letting it loop, and sessions are flagged L/XL when they get expensive ([usage](https://docs.devin.ai/admin/billing/usage), [credit limits](https://knowledge.cognition.ai/articles/1715208244-for-people-confused-about-session-credit-limits), [insights](https://docs.devin.ai/product-guides/session-insights))                                                                                                                                                                                             |
| **Factory Droid Missions** | Runs measured in hours to days                                | Mission control with separate worker and validator roles; reported median ≈2 h with 14% of missions over a day ([missions](https://factory.ai/news/missions), [review](https://www.developersdigest.tech/blog/factory-droid-review-setup-2026))                                                                                                                                                                                                                                                                                                                                                                                 |
| **Cursor Cloud Agents**    | Spend limit, VM snapshots; no documented fixed runtime        | Background VM, artifacts, remote desktop; the limit people hit is usage ([docs](https://cursor.com/docs/cloud-agent))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Cross-harness pattern: almost nobody enforces a wall clock _inside_ the loop. They cap turns,
money or usage windows, and long tasks are handled by sleeping, pausing or restarting. The best
public result for wall-clock budgeting comes from research, not a product:

- **On the Clock (arXiv 2610.10833).** With the budget stated only in the prompt, an agent used
  **161% of a 15-minute budget** and finished on time in **15% of runs**. Adding harness clocks
  (time left in every tool result, periodic reminders, generation time) brought usage to
  **99.7%** with no measurable quality loss; enforcement (clamping a command's timeout to the
  time left, or refusing it) raised on-time runs to **74–88%**. RL improved adherence further,
  but _no_ intervention made extra time buy better results: agents learned when to stop, not
  what to do with more time. The dominant failure was launching an action longer than the time
  left with no chance to correct afterwards. ([paper](https://arxiv.org/html/2610.10833v1))
- **BAGEN** formalizes budget awareness as progressive interval estimation and finds frontier agents
  are systematically over-optimistic about remaining budget; **AgentTime** benchmarks whether
  agents can work for a requested duration.
- **USACOArena** makes time and tokens explicit currency to measure cost-aware problem solving.
  ([paper](https://www.alphaxiv.org/abs/2604.10182))

This matches omnexx's state: the cap exists, the feedback loop does not.

## 4. Principles

1. **The harness owns the clock.** The model should never have to infer elapsed time from tokens.
2. **Every observation carries time.** Remaining time and the cost of the last action belong in
   what the model reads, in the volatile part of the context so the cache prefix is untouched.
3. **Enforce at the action boundary.** Clamp first (the command still runs, shorter), refuse only
   when clamping cannot help, and say why.
4. **Allocate, don't just cap.** A total is a ceiling; a plan needs slices and re-planning.
5. **A deadline is a landing instruction.** "Finish, verify, commit, report" beats "stop now".
6. **Measure usefulness, not occupancy.** A run that burns 99% of its budget on rejected actions
   is not adherent in any useful sense.
7. **Resume must be cheap and honest.** Restarts, sleeps and provider waits must not corrupt the
   active-time accounting.

## 5. Roadmap

Ordered by evidence-per-day. Each phase is shippable on its own.

### Phase 0 — Instrument first (1–2 days)

Without numbers we cannot tell adherence from productive use.

- [x] Emit one `time.report` event per cycle and at exit: `elapsed_s`, `remaining_s`,
      `task_active_s`, `model_s`, `tool_s`, `overrun_s`, `useful_ops`.
- [x] Add a time section to `omnexx usage` (the usage ledger already attributes waste: repeat
      reads, same-error retries, compactions that did not shrink, resent context — see
      `docs/usage.md`). Reads `time.report` events from the run's events file (latest run, or
      the run id passed as the task argument).
- [x] Extend the bench with `on_budget`, `overrun`, `active_ratio` and `useful_ops_per_hour`.
      Populated by the omnexx runner from `time.report` events via `timeMetrics()`.
- [x] New suite `bench/suites/time/` with the same task at 15 m, 1 h and 4 h budgets.

**Accept:** a real 8 h run produces a readable time report; the bench prints on-budget %.
**Risk:** low. No behaviour change.

### Phase 1 — Put the clock in the loop (2–3 days)

The single highest-leverage change in the literature.

- [x] Add a volatile `# Clock` block, refreshed every turn:
      `Elapsed 47m of 2h · 1h13m left · 3 of 7 tasks done · last cycle: ... · pace: ...`.
- [x] Append `(Xs; Ym left)` to tool results.
- [x] Feed the run's actual remaining time (not the estimate) into the clock block.
- [x] Show the same numbers in the TUI/VS Code status line (TUI already shows remaining time
      via `formatRemaining`; the clock block covers the model side).
- [x] Periodic `time.reminder` event while a long tool runs.

**Accept:** on-budget ≥90% at 15 m and 1 h on the time suite, quality within noise, context
overhead <1% of tokens.
**Risk:** cache misses if the block leaks into the stable prefix. Keep it volatile.

### Phase 2 — Enforce at the action boundary (2 days)

- [x] Clamp every bounded operation to `remaining - reserve`, not just bash: browser waits, dev
      servers, subagent budgets, long model calls where the provider supports it. (bash already
      clamped via `maxCmdTimeoutMs`; other tools are refused when their declared timeout exceeds
      the time left.)
- [x] Refuse an action whose declared timeout exceeds the time left, and return a short hint.
- [x] Keep the mid-cycle abort, but always write a final report before exiting.
- [x] Add a hard floor: never start work with less than the time needed for verify + commit.

**Accept:** no bench run exceeds 105% of budget; no orphan processes; quality within noise.
**Risk:** medium. Refusals can make the agent retry; cap consecutive refusals.

### Phase 3 — Land instead of stopping (2–3 days)

- [x] Replace `inWrapup → finalVerify → budget-stop` with a `landing` phase: enter `landing`
      and keep going so the in-flight task can finish inside the reserve; verify the last green
      state, commit, write the report at exit.
- [x] Keep a hard floor (2% of budget) that stops the run only to leave room for final verify.
- [x] Use the reserve for the report, not for new scope.

**Accept:** final verification always runs; ≥50% of the reserve is used for landing on tasks that
need it; no partial commits.
**Risk:** low–medium; changes exit paths that tests already cover.

### Phase 4 — Allocate time, re-plan on burn (1 week)

- [x] Planner estimates minutes per milestone (`minutes` field on plan nodes; `S/M/L` still
      defaults to 15/45/120). (Calibration from Phase 0 history is the follow-up.)
- [ ] Supervisor gives each milestone a slice of the remaining time and checks burn at cycle
      boundaries. (Advisory only today: `time.task_overrun` event.)
- [ ] Over 1.5× a slice: park, split or descope before starting more.
- [ ] Ahead of pace: pull the next slice forward; if nothing is left, go to `beyond` with evidence.
- [x] Re-plan trigger: 50% of time spent and <40% of planned tasks done (`time.replan_needed`).

**Accept:** fewer tasks started-but-unfinished at the deadline; better quality per active hour on
the time suite.
**Risk:** medium; a bad estimate can thrash. Start with advisory slices, then enforce.

### Phase 5 — Make extra time productive (research, 1–2 weeks)

The paper's negative result is the warning: adherence is easy, usefulness is not.

- [x] Define `useful_ops` (accepted commits) and emit it per cycle in `time.report`.
- [x] Stop when the last N rounds produced no accepted work (reuse `idleRounds`), instead of
      filling time with retries. (already in autonomous `beyond`.)
- [x] When ahead, prefer _new evidence_ (a failing test, a real bug, a missing edge case) over
      re-running the same checks. (`beyond` mines evidence.)
- [ ] Measure the paper's test directly: does quality improve from 15 m → 1 h → 4 h?

**Accept:** quality improves with budget on ≥2 of 3 time-suite tasks; no increase in rejected
actions per hour.
**Risk:** high; this is the open problem.

### Phase 6 — Multi-day reliability (ongoing)

- [x] Decouple `max_cycles` from duration: `cycles_per_hour` (default 12) scales the cap.
- [ ] Checkpoint cadence independent of cycles; resume with correct `activeMs`.
- [ ] Soak test: 48 h run surviving `kill -9`, laptop sleep, network loss, provider quota
      exhaustion and a clock jump.
- [ ] Clarify `unlimited`: either truly remove the cycle/idle guards or rename it.

**Accept:** 48 h run survives 3 forced restarts with <5 minutes of lost work and no time
accounting drift.
**Risk:** medium; mostly test infrastructure.

## 6. Experiments

| Axis        | Values                                           |
| ----------- | ------------------------------------------------ |
| Budget      | 15 m, 1 h, 4 h                                   |
| Clock       | off (today), on (Phase 1)                        |
| Enforcement | off, clamp, clamp + refuse                       |
| Allocation  | none, advisory slices, enforced slices           |
| Task        | 2 small, 2 medium, 1 large from the bench suites |

For each cell: 3 seeds, same model and provider, fresh worktree.

Metrics:

- **Adherence:** on-budget %, mean overrun, worst overrun.
- **Quality:** bench score / tests passed on the final commit.
- **Useful time:** accepted commits and passing gates per active hour.
- **Churn:** rejected attempts per cycle, repeat tool calls, same-error retries (the ledger
  already records these).
- **Interventions:** human messages per 8 h of run.

Targets for the first release of the program: on-budget ≥90%, no run >1.05×, quality no worse
than today, and a measurable upward slope of quality with budget.

Run it with the existing harness:

```bash
npm run bench -- --suite time --agents omnexx --hours 0.25
npm run bench -- --suite time --agents omnexx --hours 1
```

## 7. Open questions

1. **Deadline or target?** `--for 2h` currently means "cap". Do people mean "finish by" or "spend
   about"? Proposal: `--for` = target, `--by 14:00` = hard deadline.
2. **Which clock?** Active time (today) excludes provider waits and daily-cap pauses. People
   experience wall-clock. Show both, budget on active, report wall.
3. **Sleep and clock jumps.** Laptop suspend must not consume budget or inflate elapsed time.
4. **Money in the clock?** The model sees time but not USD. Adding spend may improve restraint
   but costs cache and attention.
5. **Reserve size.** Fixed 8%, or `max(5 min, 2 model calls)` scaled to the budget?
6. **Slice granularity.** Per milestone (cheap to enforce) or per task (accurate, more
   bookkeeping)?
7. **What counts as useful?** Without a judge, accepted commits + gates are the best proxy; is
   that enough for the Phase 5 target?
8. **Cross-restart continuity.** Should a resumed run remember "2 h requested, 1 h 40 m already
   spent" in the prompt? (It does in state, but `timeBrief` is static.)

## 8. Decision log

| Date       | Decision                                                         | Why                                                                                           |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 2026-10-28 | Treat adherence and productive use as separate goals and metrics | The literature shows one is tractable and the other is not; conflating them hides regressions |
| 2026-10-28 | Automate the clock before changing planning                      | Prompt-only time budgets fail (161% overrun); feedback is cheaper than re-planning            |

## 9. Log

Working rhythm: each session picks one open question or one unchecked roadmap item, runs the
smallest experiment that can settle it, and appends the result here with numbers. Tick the
roadmap item only when its acceptance test passes.

- **2026-10-28** — Created. Read the run/budget/stuck machinery, the planner brief and the run
  estimator. Surveyed Claude Code, Codex, OpenHands, Devin, Factory, Cursor and the time-budget
  papers. Round 1 conclusion: omnexx already has honest accounting and hard caps; it is missing
  in-loop time feedback, allocation and a landing phase. No measurements taken yet.
- **2026-10-28 (Phase 0)** — Emitted a `time.report` event per cycle (in `Supervisor.cycle`)
  and at exit, with elapsed/remaining/task-active/model/tool/overrun/useful-ops fields;
  accumulators live on `Run` and are fed from `onResponse` and the `tool.call` event. Added a
  Time section to `omnexx usage` reading `time.report` events from the run's events file. Added
  `on_budget`/`overrun_ms`/`active_ratio`/`useful_ops_per_hour` to `BenchmarkResult`, a
  `time` bench suite reusing jimmy10 tasks, and populated the four fields in the omnexx runner
  via `timeMetrics()`. Phase 0 complete.
- **2026-10-28 (Phase 1)** — Injected a volatile `# Clock` system block into the worker prompt
  every cycle (elapsed, remaining, tasks done, last cycle's model/tool time, pace), plus a
  `(Xs; Ym left)` annotation on every tool result and a periodic `time.reminder` event while a
  long tool runs. `deadlineMs` threaded into `LoopDeps`. See PR #360.
- **2026-10-28 (Phase 2)** — Enforcement at the action boundary: refuse tools whose declared
  timeout exceeds the time left (with a hint) and refuse any tool start with under a minute left.
  See PR #362.
- **2026-10-28 (Phase 3)** — Landing instead of stopping: `inWrapup` enters a `landing` phase
  and keeps going; a 2% hard floor leaves room for final verify, which now runs in the exit path.
  See PR #363.
- **2026-10-28 (Phase 4)** — Per-task time estimates (`minutes`), `time.task_overrun` and
  `time.replan_needed` events. Slice enforcement and automatic re-planning remain advisory.
  See PR #365.
- **2026-10-28 (Phases 5–6)** — `useful_ops` already emitted; `beyond` already mines evidence
  and stops on idle rounds; `max_cycles` now scales with `max_hours`. Measurement (quality vs
  budget) and the 48 h soak test remain. See PR #366.

## 10. References

- Wang et al., _On the Clock: Towards Punctual and Productive Time-Budgeted AI Agents_,
  arXiv:2610.10833 — https://arxiv.org/html/2610.10833v1
- _Credit-Budgeted ICPC-Style Coding_ (USACOArena), arXiv:2604.10182 —
  https://www.alphaxiv.org/abs/2604.10182
- AgentTime: runtime estimation and control — https://www.emergentmind.com/papers/2610.09944
- Claude Code self-hosted runner flags — https://code.claude.com/docs/en/self-hosted-environments-reference
- Claude Code unattended timeouts and retries —
  https://reveneau.com/guides/claude-code-agent-costs/timeouts-retries-and-cleanup-for-unattended-runs
- Claude Code deadline guard hook —
  https://github.com/kochetkov-ma/claude-brewcode/blob/main/brewtools/skills/agent-deadline-setup/assets/agent-deadline-guard.mjs
- OpenHands iteration limit — https://github.com/OpenHands/OpenHands/issues/9426
- Devin usage and idle behaviour — https://docs.devin.ai/admin/billing/usage
- Factory Missions — https://factory.ai/news/missions
- Cursor Cloud Agents — https://cursor.com/docs/cloud-agent
- In-repo harness comparison — `docs/comparison.md`
