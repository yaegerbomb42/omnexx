# Decisions

One entry per deviation from `docs/PLAN.md` or non-obvious choice. Newest entries at the bottom.
Format: date, decision, why, alternatives considered.

---

## D1 (2026-10-03) Handoff deviations adopted wholesale

**Decision.** The Oct 3 handoff overrides the plan where they differ:

- The GitHub repo already existed, so it was cloned instead of `git init`.
- Work happens on `feat/m0-m2-core`, which is pushed with a draft PR. Nothing is pushed to `main`, nothing is force-pushed, nothing is published to npm.
- Decisions live in `docs/DECISIONS.md` (this file), not `docs/decisions.md`.
- Linux and systemd are the primary service target (the Oracle VPS); launchd is second.
- A minimum version of budget caps (per-cycle turns/tokens, pre-flight, run-level USD/hours/cycles, `warn_at`) and of stuck detection (3 signals plus ladder rungs 1, 5 and 6) moves from M3 into M1/M2.
- The Nimble fast judge (plan §13) ships in M1/M2 as a `Judge` interface with `none`, `nimble` and `llm` implementations. It is off by default.
- No CI workflow uses an API key or calls a paid API. There is no real-API nightly job; `nightly.yml` runs chaos ×200 only.

**Why.** The handoff says these are deliberate. Budget caps and stuck detection are what keep an unattended run from burning money, so no real run should exist without them.

**Alternatives.** Following plan §12 literally (no push, M3-only guards) was rejected by the handoff.

## D2 (2026-10-03) TypeScript 6.0.x instead of 7.x

**Decision.** Pin `typescript@6.0.3`.

**Why.** TypeScript 7 (the native port) is the npm `latest`, but `typescript-eslint@8.71` declares `typescript >=4.8.4 <6.1.0` as its peer range. `strictTypeChecked` linting needs the type-aware API, so lint would break or be unsupported on 7.

**Alternatives.** TS 7 with `--legacy-peer-deps` (unsupported combination, risk of silent lint gaps); dropping type-aware lint (violates the quality bar).

## D3 (2026-10-03) Model aliases and prices

**Decision.** `src/providers/pricing.ts` maps `opus → claude-opus-5-5`, `sonnet → claude-sonnet-5-5`, `haiku → claude-haiku-4-5-20251001`, with the per-MTok prices from https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-03). Every entry is overridable from `[pricing.<alias>]` in config.

**Why.** The handoff forbids invented IDs or prices. Opus 5.5 cache reads are 0.05× base input, not the usual 0.1×, so the table stores each rate explicitly instead of deriving it from multipliers.

**Alternatives.** Hard-coding multipliers (wrong for Opus 5.5 and Fable 5.1).

## D4 (2026-10-03, late) Change of direction: personal use, 24 h runs, worker backends

**Decision.** Adopt the revised plan (§14, §15) and handoff mid-M0, without restarting:

- Omnexx is a personal tool for one user. Public-product work (multi-user, marketing, comparison claims, a heavy release pipeline) is dropped or demoted. The changesets config stays because it costs nothing, but no Version-Packages workflow will be added.
- M2 gains the hierarchical plan (goal → milestones → tasks, rolling wave), the incremental codebase map, milestone checkpoints (`omnexx checkpoints`, `diff --since`), the morning-after report (`omnexx report`, auto-written at every terminal outcome) and the wrap-up reserve.
- Budget defaults become the 24 h set: `max_usd = 50`, `max_usd_per_day = 50`, `max_hours = 24`, `max_cycles = 300`, `wrapup_reserve = 0.08`.
- M0–M2 build only the `WorkerBackend` interface, the `[workers]` config (all off, `max_concurrent = 1`), the harness-side lifecycle and a fake worker for tests. No real adapters until M3, and no installed harness is ever run.

**How existing work was adapted.** At the time of the change only the plan copy was committed, and the M0 config schema was uncommitted. The schema was edited in place: new budget defaults plus `wrapup_reserve`, and a `[workers]` section where `max_concurrent`/`priority` are fixed keys and every other key is a per-worker table (`[workers.aider]`, as in plan §15.3), validated by the same strict worker schema. Unknown worker IDs are accepted. Enabling one fails at run start with "adapter not available until M3". The plan schema planned for M1 is designed as a tree from the start, so nothing has to be rewritten in M2.

**Alternatives.** Finishing M0–M1 against the old plan and retrofitting later would have meant migrating `plan.json` and the config defaults twice.

## D5 (2026-10-04) `node-test` (TAP) parser and Node-test fixtures

**Decision.** Added a `node-test` parser for `node --test --test-reporter=tap`, and every fixture repo uses Node's built-in runner. Fixture gates call `node --test` with no path.
**Why.** Fixtures must need no `npm install` (handoff §5). Node 22 rejects a directory argument to `--test`; auto-discovery works on 22 and 24 (CI caught this).
**Alternatives.** Vendoring vitest into fixtures (slow, huge); generic exit-code gates (loses failure ids, so no ratchet test).

## D6 (2026-10-04) Fixture `ts-failing-test` is plain JavaScript

**Decision.** Kept the plan's name but wrote it in ESM JavaScript.
**Why.** Compiling TypeScript inside a fixture needs `typescript` installed in it.

## D7 (2026-10-04) Task "done" is decided by the task's check commands

**Decision.** Each plan node has `checks[]` (shell commands). A cycle is _accepted_ when the gates pass the ratchet and anti-cheat; the task is _done_ only when its checks also pass (or it has none). Accepted-but-not-done commits are kept as partial progress. A task with checks that already pass before any edit is done at zero cost (plan §4.6). Plans hold 1–200 tasks (the plan said 5–200; a small goal shouldn't be padded).
**Why.** The plan says the agent can't mark tasks done; only commands can.
**Alternatives.** Letting the model declare completion (rejected: reward hacking).

## D8 (2026-10-04) Extra stuck signal `max_task_cycles`

**Decision.** A task that has used 8 cycles without finishing is stuck, even if some cycles were accepted partials.
**Why.** "Same task rejected N times in a row" never fires on a task that keeps landing tiny partial commits forever.

## D9 (2026-10-04) Every-parked ends as `needs-human`, not "finished with N parked"

**Decision.** When nothing is runnable and something is parked, the run ends `needs-human` (exit 2).
**Why.** The handoff's rung 6 says so explicitly; the plan's "finished with N parked" wording predates it. The report's section 7 lists what needs a decision.

## D10 (2026-10-04) Commits skip user hooks and signing

**Decision.** Checkpoint commits use `--no-verify`, `core.hooksPath=/dev/null` and `commit.gpgsign=false`, with a fallback identity only when none is configured.
**Why.** A pre-commit hook or a signing passphrase prompt can hang or veto an unattended run; the gates are the judge.

## D11 (2026-10-04) Deterministic commit messages and progress summaries

**Decision.** Commit subjects are `omnexx(<task>): <title>` with the agent's own final summary as the body; progress entries are facts plus the agent's summary. No cheap-model call for either.
**Why.** Model routing (planner/worker/cheap per turn) is M3. The agent's last message already is a summary and costs nothing extra. The cheap model is used where the plan requires it in M2: codemap one-liners and notes consolidation.

## D12 (2026-10-04) The report is fully deterministic

**Decision.** `REPORT.md` is built from state, plan, events and git, with zero model calls (the plan allows at most one).
**Why.** It must be writable after a budget stop, and the summary paragraph adds little over the outcome line.

## D13 (2026-10-04) Scratch space is the run's own tmp dir only

**Decision.** Outside the worktree, the agent's commands may write only inside `/tmp/omnexx-<runId>` (also its `TMPDIR`).
**Why.** The first version allowed any `omnexx-*` directory under the temp dir, and CI on Linux showed `rm -rf ../` passing when `OMNEXX_HOME` itself lived under `/tmp`.

## D14 (2026-10-04) Lock takeover is serialized

**Decision.** A stale lock is replaced only while holding a short-lived `lock.takeover` file created with `O_EXCL`, re-checking staleness inside it.
**Why.** The plain "rename the stale lock away" approach let a slow contender rename away a fresh lock another contender had just written (found by a 5-way race test).

## D15 (2026-10-04) `budgetExhausted` flag

**Decision.** When a pre-flight check refuses a call for `max_usd`, the run stops with `budget-stop` at the next boundary, even though spend is still just under the cap. The flag clears when a supervisor starts (so raising the cap and resuming works).
**Why.** Without it the run kept retrying cheap no-op cycles, parked tasks and ended `needs-human` instead.

## D16 (2026-10-04) Nimble wire format is an assumption

**Decision.** The adapter sends `{name, type, question, options|levels}` and accepts answers keyed by name (object or array). Any mismatch is a logged `judge.miss`.
**Why.** I couldn't confirm the exact schema in this session; fail-open makes a wrong guess harmless. Verify before enabling.

## D17 (2026-10-04) LLM judge probabilities

**Decision.** The `llm` judge reports the chosen option with the model's stated confidence and splits the rest evenly.
**Why.** An LLM via a tool call has no calibrated probabilities; this keeps the answer shape identical to Nimble's for logging and the steer threshold.

## D18 (2026-10-04) Workers: lifecycle only, invoked directly in tests

**Decision.** `runWorkerCycle()` is complete and tested with a fake worker, but the supervisor never calls it in this build (no routing, no adapters).
**Why.** Handoff §4.3: routing, rotation and the second-opinion rung are M3, and nothing should pretend to work.

## D19 (2026-10-04) Service unit details

**Decision.** The systemd unit uses `Restart=on-failure`, `RestartSec=30` plus `RestartSteps`/`RestartMaxDelaySec` (systemd ≥ 254 backoff; older versions ignore those two keys), `Nice`, optional `CPUQuota`/`MemoryMax`. `resume --all` stays in the foreground with attached child supervisors so the service manager sees the process tree. The node path is resolved from `PATH` (e.g. `/opt/homebrew/bin/node`) rather than a versioned Cellar path that breaks on upgrade. `install` writes the unit and enables it; it never runs `sudo` (it prints the `loginctl enable-linger` command).

## D20 (2026-10-04) Test-process entry bundled with tsup

**Decision.** Real-process tests (detach, reboot, chaos) run `test/.build/process-entry.js`, bundled by a vitest `globalSetup` from `test/support/process-entry.ts`. It runs the real CLI with a scripted provider, a warp clock (sleeps advance virtual time) and SIGKILL hooks.
**Why.** Chaos needs a real `SIGKILL` of a real supervisor; test-only scaffolding must not ship in `dist/`. `tsup` is already a dev dependency.

## D21 (2026-10-04) CI placeholder key for `doctor --offline`

**Decision.** The CI smoke step sets `OMNEXX_ANTHROPIC_API_KEY=sk-ant-ci-placeholder-not-a-key`.
**Why.** A missing key is a `doctor` failure; offline, the key is never sent anywhere.

## D22 (2026-10-04) Not implemented, by design

`openai-compat` provider (no typed stub either; `models` with another provider prefix fail with "not implemented"), `sandbox = "docker"`, `open_pr`, `max_usd_per_day` enforcement, model routing, in-cycle compaction, flaky handling, ladder rungs 2–4, real worker adapters. Each fails loudly or is documented as accepted-but-not-enforced.

## D23 (2026-10-04) Risk noted: Haiku 4.5 retirement

`claude-haiku-4-5-20251001` is the `cheap` default; Anthropic lists its retirement as "not sooner than October 15, 2026". Override `[models] cheap` or `[pricing.haiku]` when it's retired.

## D24 (2026-10-04) Owner delegated release decisions; first real-API run; 0.1.0

**Decision.** At the owner's request ("your call on all decisions; I want a working CLI and a site that shows the download"), PR #1 was merged, the real-API e2e and one full `omnexx run` were executed (total under $0.10), and the package is versioned `0.1.0` for npm.
**What the real API found.** The `remember` tool's schema was a top-level union; the Messages API requires `type: "object"` at the top of every tool schema. It's now one flat object with per-action checks in the handler, and a unit test asserts every tool schema is a plain object.
**Results.** e2e: solved in one cycle, $0.0071, 3 turns, cache-read share 0.90 from turn 3. Full run: planned, fixed, committed, finished in 20 s for $0.06.

## D25 (2026-10-05) Docker sandbox: one long-lived container per run

**Decision.** One container per run (`docker run -d … sleep infinity`), commands via `docker exec`, mounted at the same absolute paths as on the host so logs, parser locations and the path jail agree. Each command runs under `setsid` with its pgid recorded, so a timeout kills it inside the container. Defaults: `node:22-bookworm`, `bridge` network, 2 CPUs, 4 GB, 1024 pids.
**Why.** A container per command would add seconds to every `bash` call; a shared container keeps `node_modules` and caches warm across a cycle.
**Not yet.** Per-domain egress allowlist; worker backends inside the container.

## D26 (2026-10-05) Ladder rung 2: escalate to the strong model

**Decision.** The ladder is now retry with evidence → escalate model → park. Escalation sets `escalated` on the task, so its cycles use the planner model, and resets the consecutive-rejection and signature counters so the strong model gets its own three attempts; approaches tried and evidence carry over. `switch_to_strong_model` is now an implemented judge action (steer mode only).
**Why.** Cheaper than parking a task that a stronger model can solve, and bounded: an escalated task that keeps failing parks after three more rejections, or at `max_task_cycles`.

## D27 (2026-10-05) Ladder rung 3: split a stuck task; climb on stalled partial progress

**Decision.** After the strong model also gets stuck, the planner splits the task into 2–4 new tasks under the same milestone. The original is parked with `splitInto` and marked done when all of them are; tasks that depended on it now depend on the new ones. If the planner produces nothing, the task parks. `split_task` is now an implemented judge action.
**Bug fixed on the way.** The ladder only climbed on rejections, so a task that kept landing accepted-but-unfinished commits looped until the budget ran out. It now also climbs when the cycles-per-task signal fires on accepted partials, and that signal counts cycles since the task reached its current rung (`rungStartedAt`), so each rung gets its own allowance.

## D28 (2026-10-05) Rolling daily cap

**Decision.** Spend is recorded with timestamps (`spendLedger`, last 25 h). Every model call is pre-flighted against `max_usd_per_day` over the rolling 24 h window. At 90% of the cap, or after a call was refused for it, the supervisor pauses at the next cycle boundary until at least half the cap has rolled out of the window, then resumes. Pause time is excluded from `max_hours`. A cycle cut short by a budget cap before it changed anything is recorded as "interrupted": not an attempt, not a rejection, not a lack of progress.
**Why.** Refusing calls without pausing made every following cycle end before its first call, which the stuck detector then read as failure.
