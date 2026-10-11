# Omnexx: Build Plan

> **Set a goal, walk away, come back to commits.**
> Jimmy's personal coding agent: one agent that takes on huge tasks and works for ~24 hours without anyone steering it.
> Its own checks decide whether each step is kept, and every kept step becomes a git commit.

| | |
|---|---|
| Owner | Jimmy (GitHub `yaegerbomb42`) |
| Status | Plan only. No code written, nothing deployed, no repos changed. **Revised Oct 3 (late): personal-use focus (§0, §14) and worker backends (§15).** |
| Date | Saturday, Oct 3, 2026 |
| Products | 1) `omnexx` CLI (npm, for Jimmy's own use) · 2) a simple one-page site at **omnexx.org** · 3) later: an "ops agent" mode |
| Audience | **Personal use only.** One user (Jimmy), on his Mac and his Oracle VPS. Not a public product: no multi-user features, marketing or public comparison claims. |

---

## 0. TL;DR (decisions in one screen)

> **Revision (Oct 3, late): personal-use focus.** Omnexx is a single agent **for Jimmy** that should work better than the alternatives on *his* huge tasks, running about **24 hours** on its own. Public-product concerns (multi-user, marketing, public comparison claims, a heavy release process) are dropped or demoted. The npm package and the landing page stay, kept simple. What gets priority is anything that makes long, huge-task runs succeed: a **hierarchical plan**, **sharper long-horizon memory** (lessons file plus a codebase map), **checkpoints**, a **morning-after report**, and **budget defaults tuned for one 24 h run** (§14). New in M3: **worker backends**. Omnexx can hand tightly scoped subtasks to Jimmy's other installed harnesses through their headless modes, and the same gates judge the result (§15).

1. **One agent, strong harness.** The product is the *loop around* the model: a durable plan, fresh context each cycle, real checks as the judge, git checkpoints, rollback, stuck detection, budgets and crash-safe resume. It runs one agent and never a swarm. Optional worker backends (§15) take one delegated subtask at a time by default, and Omnexx stays in charge.
2. **Commands decide what counts as done, not the LLM.** A step is kept only when the configured gates pass (tests, typecheck, lint, and any custom command) and nothing that passed before has started failing. Otherwise the harness runs `git reset` back to the last green commit.
3. **Fresh context every cycle (the Ralph-loop idea), plus in-cycle compaction.** Each cycle re-reads `goal.md`, `plan.json` and the tail of `progress.md`. Nothing depends on a single context window surviving for days.
4. **The agent works in an isolated git worktree on branch `omnexx/<runId>`.** Your checkout and `main` are never touched, and nothing is pushed unless you opt in.
5. **Efficiency first.** The design uses a cache-friendly stable prompt prefix, small `str_replace` diffs, line-range reads, and command output trimmed by the harness before it reaches the model. A cheap model does routine work and the strong model only plans and handles escalations. No tokens are spent while a command runs.
6. **Bring your own key.** Anthropic is the primary provider and OpenAI-compatible endpoints (including your LiteLLM proxy) are optional. Omnexx's own model calls never use a personal Claude subscription login. Optional worker backends (§15) run as separate programs with whatever auth Jimmy configured in each of them, and Omnexx never reads or handles those credentials.
7. **TypeScript on Node ≥ 22, installed with `npm i -g omnexx`.** Releases are kept simple: published by hand from a tag, or through one small trusted-publishing workflow (§5.6).
8. **The site is one static HTML file served by your existing `static-landings` nginx on port 8116 through Nginx Proxy Manager.** (Update Oct 3: DWEEBS has moved out and `infra/apps/omnexx/` is empty. See §6.3.)
9. **"Better" has to be measured, for Jimmy, not for marketing.** In M4, Omnexx is benchmarked against plain Claude Code headless on the same model (plus mini-SWE-agent and Aider as cheap reference points) on Jimmy's own tasks. It only counts as better if it wins on cost per solved task without losing on solve rate. The results guide Jimmy's defaults; they are not public claims.
10. **Honest scope.** Multi-day autonomy works on goals the agent can check for itself. It does not replace product judgment.
11. **Optional fast judge (§13, added Oct 3).** An advisory Nimble 9B decision model on Ollama (usually on the Mac, reached from the VPS over Tailscale) suggests the next move at each cycle boundary and flags drift, repeated failures and risky tool calls. It is off by default, fails open, and never overrides the gates.
12. **Built for one huge task per ~24 h run (§14).** A hierarchical plan (goal → milestones → tasks), a capped lessons file plus an incrementally maintained codebase map, milestone checkpoints, a morning-after report, and budget defaults sized for one 24 h run.
13. **Worker backends (§15, M3).** Omnexx stays the single agent in charge but can delegate tightly scoped subtasks to Cline, OpenHands, OpenCode, Aider, Hermes, Pi or Claude Code through their headless modes, using their own quotas. Every worker result is only a candidate diff, judged by the same gates. Each worker is opt-in, all are off by default, and one runs at a time by default.

---

## 1. Positioning

**Tagline:** *Set a goal, walk away, come back to commits.*

**What Omnexx is:** a CLI that runs **one** coding agent against **one** repo for hours or days. It keeps working through crashes, reboots, flaky tests and dead ends, and it leaves a clean trail of small, verified commits plus a readable journal of what it did and why.

**Who it's for:** Jimmy. (Revised Oct 3: personal use only.) He already trusts a strong coding agent (Claude Code is the bar) but is tired of babysitting it. He wants to hand off one huge, *checkable* job in the evening and review commits plus a morning-after report the next day. Anything that only matters for other users is out of scope.

**Where it works (and where it doesn't), said plainly:**

| Works well: the goal is machine-checkable | Works poorly: needs human judgment |
|---|---|
| "Make the whole test suite pass on Node 24" | "Make the onboarding feel better" |
| "Implement every item in `SPEC.md`'s checklist; each item has a test" | "Design the pricing page" |
| "Migrate from Jest to Vitest; coverage must not drop" | "Decide which features to cut" |
| "Port module X from JS to strict TS; `tsc --noEmit` clean" | Open-ended refactors with no tests |
| "Upgrade to React 19; build plus e2e green" | Security audits (too many plausible false positives) |
| Dependency upgrades, lint debt, test backfill, DB migrations with checks | Anything where "done" is a matter of taste |

Omnexx says this out loud. `omnexx init` asks for (or detects) the gate commands and **refuses to start a multi-day run without at least one gate** unless you pass `--i-know-there-are-no-checks`. In that mode the run is capped at a single cycle by default.

**What makes it different (from the research in §2):**

- **An external judge plus a ratchet.** Most tools ask the model whether it's done. Omnexx asks your commands, records a baseline, and never accepts a step that makes something that used to pass start failing. It also blocks the reward-hacking moves agents fall into, such as deleting tests, adding `.skip`/`.only`, or editing protected files.
- **Built to survive days, not hours.** The state machine is crash-safe, takes a lock, survives reboots through systemd or launchd, and sends heartbeats and ntfy pushes. Competitors either run in a hosted VM (Devin, Cursor) or leave the outer loop to you (Claude Code `-p`, Codex `exec`, Aider, Ralph).
- **Stuck detection with a strategy ladder.** Instead of looping until the money runs out, Omnexx detects repetition and oscillation, then escalates the model, re-plans, reverts and tries another approach, parks the task, and finally stops and pings you.
- **Efficiency you can see.** It reports tokens and dollars per accepted commit and per finished task, plus cache-hit rate, and publishes the numbers against other tools.
- **One agent, on purpose.** You get one coherent author per run, one transcript and one budget, with no merge conflicts between parallel agents.

---

## 2. Competitor research (as of Oct 2026)

| Tool | What it does for long runs | Where it falls short on multi-day, unattended work | Sources |
|---|---|---|---|
| **Claude Code headless (`claude -p`) / Claude Agent SDK** | Same agent loop as Claude Code. Sessions can be resumed, there's built-in compaction, `maxTurns` / `maxBudgetUsd`, hooks, subagents, and `--bare` for reproducible scripted runs. Best-in-class tools and model. | It's a building block, not a supervisor. Docs say a **session has no wall-clock timeout of its own**, so you bound it with turns and budget. There's no built-in plan ledger, judge, rollback, stuck detection, reboot-resume or notifications. Anthropic's own harness write-up says **"compaction isn't sufficient"** for multi-window work. | https://code.claude.com/docs/en/headless · https://code.claude.com/docs/en/agent-sdk/agent-loop · https://code.claude.com/docs/en/agent-sdk/hosting |
| **Anthropic "effective harnesses" pattern** | An initializer session writes `feature_list.json` (all items `passes:false`), `claude-progress.txt` and `init.sh`. Every later session does one feature, verifies it, commits and appends progress. Git is the record. | It's a pattern, not a product. The documented failure modes are trying to build everything in one shot, **declaring victory early**, and marking features done without end-to-end tests. Omnexx bakes the fixes into the harness instead of the prompt. | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| **"Ralph Wiggum" loop** | `while :; do cat PROMPT.md \| claude -p; done`. Fresh context each iteration, one task per loop, and `IMPLEMENTATION_PLAN.md` as shared state on disk. Shipped "6 repos overnight" at a hackathon. | No budget, no stuck detection, no rollback, and no judge besides the agent itself. Common failure: the agent concludes after a `rg` search that something "isn't implemented" and redoes it. The official Claude Code plugin re-feeds the prompt **inside one session** through a Stop hook, so context bloats (community reports). | https://ghuntley.com/ralph/ · https://github.com/ghhuntley/how-to-ralph-wiggum · https://github.com/anthropics/claude-code/blob/a56ff02e/plugins/ralph-wiggum/README.md · https://www.reddit.com/r/ClaudeCode/comments/1qc4vg0/ |
| **OpenAI Codex CLI (`codex exec`)** | Non-interactive mode, `exec resume --last`, explicit sandbox modes, `/compact`, and goals. OpenAI reports a **~25 h uninterrupted run, ~13M tokens, ~30k LOC** driven by `plans.md` / `implement.md` / a status doc with validation per milestone. | The long run depended on hand-written runbooks. There are documented **token-burn polling loops**: one issue reports 34.6M tokens spent polling after the task had already finished, and there are no event-driven wake-ups for background commands. | https://developers.openai.com/codex/noninteractive.md · https://developers.openai.com/blog/run-long-horizon-tasks-with-codex · https://github.com/openai/codex/issues/38495 · https://github.com/openai/codex/issues/32188 |
| **OpenHands (CLI / SDK)** | `--headless` with JSONL events and an `LLMSummarizingCondenser` for long histories. Open source and works with any model. | Headless mode **always auto-approves** with no guard layer. The standalone CLI repo now says it's **"no longer actively maintained"**. Users report condenser configuration being ignored in some modes ("long-running sessions hit context limits and crash"). | https://docs.openhands.dev/openhands/usage/cli/headless · https://docs.openhands.dev/sdk/arch/condenser · https://github.com/openhands/openhands-cli · https://github.com/OpenHands/OpenHands/issues/12590 |
| **Aider** | Scriptable (`--message`, `--yes-always`) with `--auto-test` / `--test-cmd` feedback. Architect/editor split pairs a strong planner with a cheap editor, and repo-map context keeps it token-frugal. | Built around one request per invocation. There's no durable plan, multi-cycle supervisor, budget or resume, so it's great inside a cycle but not across days. | https://aider.chat/docs/scripting.html · https://aider.chat/docs/config/options.html |
| **Devin** | Hosted async "AI engineer" with its own VM, Slack/PR workflow, and good results on narrow tickets. | An independent month-long trial saw **14 failures, 3 inconclusive and 3 successes out of 20 tasks**, with the agent spending "days pursuing impossible solutions rather than recognizing fundamental blockers." It's opaque, costs can climb, and reviews note "no clear abort-and-save mechanism." | https://www.answer.ai/posts/2025-01-08-devin.html · https://litmustools.com/review/devin/ · https://awesomeagents.ai/reviews/review-devin/ |
| **Cursor Cloud Agents (formerly Background Agents)** | Isolated cloud VMs, many in parallel, that open PRs with artifacts. They support hooks and MCP and are billed at API pricing with a spend limit. | Hosted and built around parallel runs. The long-running mode is team-scoped and warned to run "many hours" at "hundreds of dollars." It isn't your machine, and the judge is still mostly the agent. | https://cursor.com/docs/cloud-agents · https://www.learncursor.dev/learn/cursor-agents/cloud-agent-settings |
| **mini-SWE-agent** (benchmark baseline) | A minimal bash-only harness with per-run cost limits, used as a SWE-bench reference. | Not a product for long runs. Useful as an efficiency yardstick: one published run used ~88M input tokens over 207 tasks for $16 with GPT-5-mini. | https://mini-swe-agent.com/v2/usage/swebench/ · https://aclanthology.org/2026.findings-acl.1652.pdf |

**What the research says about long runs:** reliability **drops faster than linearly as tasks get longer** (https://arxiv.org/html/2603.29231). The recommended fixes are small units of work, stable IDs and checkpoints. That is exactly what Omnexx's cycle design does.

**What this means for Omnexx:**

1. Don't try to beat Claude at coding. **Use Claude, and beat everyone at the loop.** The parts nobody ships well are the judge, the ratchet, rollback, stuck handling, budgets and crash-safe resume.
2. **A fresh context every cycle** (Ralph and the Anthropic harness), not one session kept alive forever (the Ralph plugin, Codex goals).
3. **Never poll with the model.** The harness waits for commands with a timeout and spends zero tokens while it waits (the lesson from the Codex issue).
4. **Split strong and cheap models** (Aider's architect/editor idea) for routine turns.
5. **Make "stop and ask" a first-class outcome.** The worst failure (Devin) is spending days on something impossible. Parking a task and pinging you counts as success.

---

## 3. Architecture for days-long runs

### 3.1 Core concepts

- **Run:** one goal against one repo. It has an ID (`r_20261003_1834_ab12`), a branch (`omnexx/<runId>`), a worktree, a budget and a state directory.
- **Plan:** an ordered list of **tasks**, each small (≤ ~1–2 h of agent work) and each with **acceptance checks**.
- **Cycle:** one attempt at one task with a **fresh model context**. A cycle ends in exactly one of: `accepted` (commit), `rejected` (rollback), `parked` or `aborted`.
- **Gate:** a shell command whose exit code and parsed output judge a cycle.
- **Checkpoint:** a git commit on the run branch that passed every gate. The last one is called `lastGreen`.

### 3.2 Process model

```
omnexx (CLI)  --spawn/attach-->  supervisor (one per run, long-lived, crash-safe)
                                    ├─ cycle runner  ->  agent loop (LLM turns + tools)
                                    ├─ gate runner   (child processes, timeouts, no LLM)
                                    ├─ git manager   (worktree, commit, reset)
                                    ├─ guards        (budget, stuck, policy)
                                    ├─ heartbeat + event log + notifier (ntfy)
                                    └─ control watcher (pause/stop requests)
```

There is exactly **one agent loop at a time**. The supervisor is deterministic TypeScript. Only the agent loop calls the LLM.

### 3.3 Durable state (on disk, re-read every cycle)

`~/.omnexx/runs/<runId>/` (state lives **outside** the repo so test runners and `git clean` never touch it):

| File | Purpose | Who writes it |
|---|---|---|
| `goal.md` | The goal as you wrote it, plus constraints. You may edit it while the run is going; it's re-read every cycle and changes are logged by hash. | You, at `init`/`run` |
| `plan.json` | Tasks: `id, title, why, acceptance[], status (todo/doing/done/parked), attempts, approachesTried[], notes, dependsOn[]`. JSON because models overwrite JSON less carelessly than Markdown (Anthropic harness finding). | Planner model, through a schema-validated tool only |
| `progress.md` | An append-only journal with one entry per cycle: what was tried, the result, the commit SHA and what's next. The last N entries go into context. | Harness (cheap-model summary + facts) |
| `notes.md` | Durable learnings about the repo, e.g. "tests need `DATABASE_URL`", "use `pnpm` not `npm`". Capped at ~1.5k tokens. | Agent, through a `remember` tool |
| `state.json` | Phase machine: `{runId, cycle, phase, taskId, lastGreen, baseline, budgetSpent, startedAt, pid, host}`. | Harness only. Atomic write (tmp + fsync + rename). |
| `events.jsonl` | Every event: turn, tool call (redacted), gate result, commit, rollback, guard trip. Rotated at 50 MB. | Harness |
| `heartbeat.json` | `{ts, phase, cycle, task, spentUsd, lastGreen, lastEvent}`, written every 15 s. | Harness |
| `control.json` | `{request: "pause"|"resume"|"stop"|"stop-now", at}` | CLI |
| `lock` | `{pid, host, bootId, startedAt}`. A stale lock is detected by pid liveness plus boot ID. | Supervisor |
| `logs/cmd-*.log` | Full untrimmed output of every command, so the agent can page through it with `read_log`. | Harness |

Every checkpoint commit carries **git trailers** (`Omnexx-Run`, `Omnexx-Task`, `Omnexx-Cycle`). If the state directory is ever lost, `omnexx resume --rebuild` rebuilds the plan status from `git log`.

### 3.4 The cycle (the heart of the system)

```
1. LOAD     read state.json, goal.md (hash), plan.json, last 5 progress entries, notes.md
2. SELECT   pick next runnable task (todo, deps done, not parked); if none -> FINISH or ESCALATE
3. PREPARE  ensure worktree HEAD == lastGreen and tree clean (else reconcile, §3.9)
4. ACT      agent loop with fresh context; bounded by turns/tokens/time per cycle
5. VERIFY   run gates (harness-side, timeouts, parsed output) + anti-cheat checks
6. JUDGE    pass + no regressions vs baseline  -> COMMIT (checkpoint), task->done or partial
            fail                               -> ROLLBACK to lastGreen, record failure signature
7. RECORD   progress.md entry, plan.json update, events, budget, heartbeat, maybe notify
8. GUARD    budget/stuck/time checks -> continue | switch strategy | park | stop
```

Each step is a **phase** in `state.json`. Steps are idempotent, so a crash restarts the current phase (§3.9).

### 3.5 Planning (the initializer)

- **Cycle 0** uses the **planner (strong) model** with read-only tools. It explores the repo, detects or validates gates, writes a **hierarchical** `plan.json` (goal → milestones → tasks; see §14.1; up to ~300 leaf tasks, each with acceptance checks), builds the codebase map (§14.2) and seeds `notes.md`. If `goal.md` points at a spec or checklist, each item becomes a task, and items are never deleted, only marked.
- **Re-planning happens only** on stuck escalation, when every task is done but a goal-level check still fails, or when you edit `goal.md` (detected by hash). The planner may split, reorder or add tasks, but **may not delete** a task. It can only park one with a reason.
- **Premature victory is blocked:** the run finishes only when every task is `done` **and** the goal-level gates pass on `lastGreen`. Parked tasks mean the run ends as "finished with N parked", and you get notified.

### 3.6 Context compaction and summarization

- **Between cycles:** the context starts fresh, so nothing carries over except the durable files. That bounds context growth over days by design.
- **Within a cycle** (long tasks):
  1. **Trim tool output at the harness** first. This is deterministic and costs no tokens (§4.4).
  2. **Clear old tool results** once they are large and stale. Use Anthropic's context-editing tool-result clearing (`clear_tool_uses_*`) where available, or local elision otherwise.
  3. **Compact at a token threshold** (default 60% of the window). Use Anthropic's server-side compaction (`compact_*` edit) when available, otherwise a local cheap-model summary into a structured `CycleSummary {done, inProgress, filesTouched, lastError, nextStep}`.
  4. **Hard cap:** if a cycle hits `max_tokens_per_cycle`, end it. Its partial work is rolled back unless the gates pass, and the summary goes into `progress.md` so the next cycle continues from there.
- Docs to re-check when building: https://platform.claude.com/docs/en/build-with-claude/context-editing · https://platform.claude.com/docs/en/build-with-claude/compaction-threshold. The edit-type identifiers have dates in them, so put them in config, not code.

### 3.7 Git checkpoints

- `omnexx run` creates a **git worktree** at `~/.omnexx/worktrees/<repo>-<runId>` on a new branch `omnexx/<runId>`, branched from the current HEAD. Your checkout, `main` and any uncommitted changes are never touched.
- Optional `setup` commands run once per worktree (e.g. `npm ci`).
- **One commit per accepted cycle.** Small and conventional: `feat(T12): add zod schema for config [omnexx]`, with the message drafted by the cheap model and trailers added. No commit is made when nothing changed.
- **Never** `push --force`, never touch `main`, and **push is off by default**. With `push = "branch"`, only `omnexx/*` is pushed (no force) after each checkpoint, so you can review from your phone. Opening a PR at the end is optional (`gh pr create`) and off by default.
- **At the end:** `omnexx status` shows `git log main..omnexx/<runId>` plus a summary, and you merge it yourself.

### 3.8 Verification gates and automatic rollback

```toml
[[gates]]
name = "typecheck"; run = "npm run typecheck"; timeout = "5m"
[[gates]]
name = "lint";      run = "npm run lint";      timeout = "5m"; level = "ratchet"
[[gates]]
name = "test";      run = "npm test -- --reporter=json"; timeout = "20m"; parser = "vitest"
```

- **Baseline:** at run start, run every gate on the starting commit and record which tests and errors already fail. Accepting a cycle requires:
  - `level = "must-pass"`: exit code 0.
  - `level = "ratchet"` (default for test/lint): **no new failures**, and the count of known failures can't go up. Pre-existing breakage isn't blamed on the agent, and the agent can't make things worse.
- **Task acceptance checks** (from `plan.json`) run as well, e.g. `vitest run test/config.spec.ts` or `grep -q "x" file`.
- **Parsers** (vitest/jest/pytest/go test/tsc/eslint, plus a generic fallback) turn output into a compact list of failures `[{id, file:line, message≤20 lines}]`. Only that list goes back to the model.
- **Anti-cheat checks** (an automatic reject plus a strong signal to the stuck detector):
  - Test count drops versus `lastGreen`, or a test file is deleted, unless the task explicitly allows it.
  - New `.skip`, `.only`, `xit`, `@pytest.mark.skip`, `// @ts-ignore`, `eslint-disable`, or snapshot rewrites (`-u`), above a threshold or not allowed by the task.
  - The diff touches `protected` paths (default: gate config, CI files, `omnexx.toml`, lockfiles unless the task is a dependency task, `.env*`).
- **Rollback:** `git reset --hard <lastGreen>` followed by `git clean -fd` **inside the dedicated worktree only**. That's safe by construction because the worktree belongs to Omnexx. The failed diff is saved to `runs/<id>/rejected/<cycle>.patch` so the next attempt can learn from it, and its *summary* goes into `progress.md`.
- **Flaky tests:** if a test fails, re-run only the failing IDs once. A test that passes on re-run is marked `flaky` in `notes.md` and doesn't count as a regression, but it's reported.

### 3.9 Resume after a crash or reboot

- **Atomic state:** every phase transition is written to `state.json` before the phase's side effects run, using tmp + fsync + rename.
- **Reconciling on start** (`omnexx resume` or service start):
  1. Lock: if the PID is dead or the boot ID differs, the lock is stale, so take it over.
  2. If the worktree HEAD isn't `lastGreen`: when HEAD is a later checkpoint commit carrying our trailers (we crashed after the commit but before the state write), advance `lastGreen`. Otherwise reset.
  3. A dirty tree means a crash mid-ACT. Save the diff to `salvage/<cycle>.patch`, reset to `lastGreen`, and restart the cycle (the task's attempt counter doesn't go up for a crash).
  4. In the VERIFY phase, re-run the gates (they're idempotent).
  5. Re-read `goal.md` and `plan.json`, then continue.
- **In-flight LLM calls** are simply re-issued. Turns are cheap to replay because the stable prefix is cached.
- **Reboot survival:** `omnexx service install` writes a **launchd LaunchAgent** (macOS) or a **systemd user unit** (Linux, with `loginctl enable-linger`) that runs `omnexx resume --all` on boot, with `Restart=on-failure` and backoff.
- **Network or API outages:** exponential backoff (up to 30 min) on 429/5xx/timeouts. The run is **paused, not failed**, and a notification goes out after 15 min of continuous failure.

### 3.10 Stuck and loop detection with strategy switching

**Signals** (computed by the harness from events, not by the model):

| Signal | Default threshold |
|---|---|
| Same task rejected N times in a row | 3 |
| Same failure signature repeated (normalized error hash) | 3 times across cycles |
| Oscillation: a diff that reverts a recent accepted diff (A→B→A by content hash) | 1 |
| No accepted commit within T or K cycles | 3 h or 8 cycles |
| Inside a cycle: the same tool call with the same arguments | 3 times |
| Inside a cycle: no file edits after K turns | 15 turns |
| Token burn rate above `x`× the median cycle without progress | 3× |

**Strategy ladder** (one rung at a time, recorded in `plan.json.approachesTried`):

1. **Retry with evidence:** the next cycle gets the failure list plus the rejected-patch summary and the instruction "do not repeat approach X".
2. **Escalate the model:** worker → planner (strong) model for this task, with a higher reasoning-effort setting.
3. **Re-plan this task:** the planner splits it into 2–4 smaller tasks, or adds a "write a failing test that reproduces it first" subtask.
4. **Try a different approach:** the planner must propose an approach that differs from everything in `approachesTried`.
5. **Park:** mark it `parked` with a reason, and move on to tasks that don't depend on it.
6. **Stop and ask:** if every runnable task is parked, or the run-level no-progress timer fires, finish with status `needs-human`, send an ntfy push with a two-line summary, and leave everything committed and resumable.

### 3.11 Budget, token and time guardrails

```toml
[budget]                     # defaults tuned for ONE ~24 h run (revised Oct 3, see §14.5)
max_usd          = 50       # whole run
max_usd_per_day  = 50       # rolling 24 h (equal to max_usd for a single 24 h run)
max_hours        = 24       # wall clock
wrapup_reserve   = 0.08     # last 8 % of budget/time: no new tasks; final gates + morning-after report
max_cycles       = 300
max_turns_per_cycle   = 40
max_tokens_per_cycle  = 400_000   # input+output, before cache discount
max_cmd_timeout  = "30m"
warn_at          = 0.8      # notify at 80 %
```

- Cost comes from a **pricing table** (`providers/pricing.ts`, which you can override in config) using the API's reported usage: input, cache write, cache read, output and reasoning tokens.
- **Pre-flight check:** before each LLM call, estimate the worst case for the next turn. If it would exceed the cap, finish the cycle gracefully instead. The overshoot is never more than one turn.
- Hitting the daily cap **pauses** the run until the 24 h window rolls, then it resumes on its own. Hitting the total, hours or cycle cap **stops** it cleanly with `lastGreen` intact.

### 3.12 Heartbeat log and ntfy notifications

- `heartbeat.json` every 15 s. `omnexx status` reports "stale" after 2 min without one.
- `omnexx logs -f` streams a human view of `events.jsonl` (cycle start, task, tool summary, gate results, commit or rollback, spend).
- **ntfy** (optional): `POST https://ntfy.sh/<topic>` with a title, priority and tags. Events that trigger a push: run started, finished, `needs-human`, budget 80%/100%, crash and resume, API outage over 15 min, and an optional daily digest (accepted commits, tasks done, $ spent).

```toml
[notify.ntfy]
server = "https://ntfy.sh"
topic  = "yaeger"          # see the warning below
token_env = "NTFY_TOKEN"   # optional, for protected topics
events = ["finished","needs-human","budget","crash","digest"]
```

  ⚠️ **Topics on ntfy.sh are public and anyone can guess them** (`yaeger` is easy). Pushes contain **only** run IDs, task titles, counts and dollar amounts, never code, diffs, paths outside the repo name, or secrets. Consider a random topic suffix or a token-protected topic (open question §11).

### 3.13 Sandboxing and safety

Two modes, picked in `omnexx init`:

- **`sandbox = "docker"` (recommended for unattended multi-day runs):** the agent's commands run in a container with the worktree mounted read-write and nothing else. Optional egress allowlist (npm registry, GitHub, the LLM API). CPU and memory limits apply, which matters on the shared VPS. The supervisor stays on the host.
- **`sandbox = "host"` (convenient, guarded):** commands run on the host under a policy layer:
  - **Path jail:** all file tools resolve `realpath` and must stay inside the worktree. Symlinks that escape are refused. Reads of `.env*`, `*.pem`, `id_*`, `~/.ssh`, `~/.aws` and similar are denied by default.
  - **Command policy:** the command is parsed (shell-quote AST, not a regex on the raw string). These are denied by default: `sudo`, `rm` with absolute or `..` paths outside the worktree, `git push`, `git reset/clean` (only the harness does git), `curl|sh`, `chmod -R /`, writing outside the worktree or `/tmp/omnexx-*`, `docker`, `ssh`/`scp`, `kill` of processes the run didn't start, package publishing (`npm publish`) and `crontab`. You can extend the list in config.
  - **Env scrubbing:** child processes get a minimal environment. **API keys are never in the agent's shell environment.** The LLM key lives only in the supervisor.
- **No secrets in logs:** a redaction filter runs on every event, log line and notification. It masks the values of known secret env vars and pattern-matches common token formats (`sk-ant-…`, `sk-…`, `ghp_…`, `github_pat_…`, `AKIA…`, `xox[bp]-…`, JWTs, PEM blocks). Unit tests cover it.
- **No network actions by the agent** besides what the gates and setup commands need. There are no email, issue or post tools. (The ops-agent mode only *drafts*, see §9.)

### 3.14 Models and providers

- **Bring your own key.** Supply it through `ANTHROPIC_API_KEY` (or `OMNEXX_ANTHROPIC_API_KEY`) or `omnexx auth set anthropic`, which stores it in a 0600 file under `~/.config/omnexx/`, with the OS keychain as a later option. It's never printed: `doctor` shows only "present (sk-ant-…xxxx)".
- **Anthropic is the primary provider**, through the Messages API with prompt caching, context editing and compaction.
- **Optional: OpenAI-compatible endpoints** (OpenAI, OpenRouter, a local or VPS **LiteLLM** proxy, Ollama). One `openai-compat` provider covers all of these.
- **Roles, not hard-coded models:**
  ```toml
  [models]
  planner = "anthropic:opus"     # planning, re-plans, escalations
  worker  = "anthropic:sonnet"   # default for cycles
  cheap   = "anthropic:haiku"    # summaries, commit msgs, failure triage
  ```
  Aliases map to concrete model IDs in the pricing table, so a new model is a one-line change.
- **Subscriptions vs API keys:** Anthropic's terms say that **products serving other users must use API keys** (Console, Bedrock, Vertex or Azure) and must not offer Claude.ai login or use Free/Pro/Max subscription limits. Omnexx is a distributed product, so it supports **API keys only** and never asks for or uses a Claude subscription login. (Using a personal Max plan with Claude Code on your own machine is a separate matter and unaffected.) Sources: https://code.claude.com/docs/en/legal-and-compliance · https://code.claude.com/docs/en/agent-sdk/overview
- **Pluggable "engine" (later):** the cycle's ACT step sits behind an `Engine` interface. M1 ships `native`, Omnexx's own lean tool loop, which is where the efficiency comes from. M4 adds `claude-agent-sdk` (Claude Code's loop driven by the Agent SDK with an API key) as both a **benchmark baseline** and an option for people who want Claude Code's exact behavior inside Omnexx's harness. The benchmark decides the default.

---

## 4. Efficiency strategy

### 4.1 Prompt caching (largest lever)

- **Stable prefix, in fixed order:** `[system prompt (versioned)] [tool schemas] [repo map] [goal.md] [notes.md]`, with a cache breakpoint after it. Then `[plan snapshot + progress tail]` with a second breakpoint, then the turn messages.
- Within a cycle the prefix is byte-identical on every turn, so cache reads bill at **~0.1× base input**. A 5-minute cache write costs 1.25× and a 1-hour write 2× (https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Use the 5-minute TTL by default. Switch to the 1-hour TTL only if measurements show gaps between turns of more than 5 minutes, which can happen during long gate runs.
- Determinism rules: no timestamps or random IDs in the prefix, tools sorted, JSON keys sorted, and the repo map rebuilt only at cycle start.
- Target: **cache-read share ≥ 70% of input tokens** by turn 3 of a cycle. It's tracked per cycle.

### 4.2 Small diffs

- The edit tool is `str_replace` (unique match required) plus `multi_edit`. Whole-file `write` is allowed only for new files or files under 50 lines.
- The diff size per cycle is reported, and cycles with diffs over 400 lines get a nudge (prompt: "split the task").

### 4.3 Targeted file reads

- `outline(path)` returns the symbols and line ranges. `read(path, start, end)` returns at most 400 lines per call. A file over 400 lines **must** be read by range, with the outline returned first.
- `search(pattern, glob)` wraps `rg` with result caps (100 hits, ±2 lines of context).
- A **repo map** (tree plus top-level symbols, ≤ 3k tokens) sits in the cached prefix, so the agent doesn't spend turns on `ls -R`.

### 4.4 Command output trimmed by the harness (zero tokens)

- `bash` output keeps the first 30 and last 120 lines, plus every line matching the error patterns. The full log goes to `logs/cmd-*.log`, readable through `read_log(id, range)`.
- Gate results reach the model only as the **parsed failure list**.
- **The model never polls.** Long commands block inside the harness until they finish or time out (the lesson from the Codex polling-loop issue).

### 4.5 Model routing

| Work | Model role |
|---|---|
| Cycle 0 plan, re-plans, escalation rungs 2–4 | planner (strong) |
| Normal cycle edits | worker (mid) |
| Commit messages, progress summaries, in-cycle compaction summaries, failure triage ("flaky / env / real?") | cheap |
| Waiting, trimming, parsing, git, budget | **no model** |

The effort or extended-thinking budget also scales: low for the worker by default, high only on escalation.

### 4.6 Early termination

- A cycle ends **as soon as the task's acceptance checks plus the gates pass**. The harness checks after every edit batch when it's cheap to (fast gates first, full gates at the end), and the model isn't invited to "polish".
- Cheap preflight: if the task's own acceptance check passes before any edit (it's already done), mark it done at zero cost.

### 4.7 Metrics that prove "more efficient than others"

Every run and every benchmark reports:

| Metric | Definition |
|---|---|
| **Resolve rate** | Tasks whose hidden or official tests pass, divided by tasks attempted |
| **$ per resolved task** | Total API spend divided by resolved tasks. **This is the headline metric.** |
| **Tokens per resolved task** | Split into uncached input, cache write, cache read and output |
| **Cache-hit ratio** | Cache-read tokens divided by total input tokens |
| **Turns per resolved task**, **wall-clock per resolved task** | |
| **Regression rate** | Accepted commits that a later full gate run shows broke something |
| **Human interventions** | The target for unattended runs is 0 |
| **Long-horizon completion** | % of checklist items done within the budget on a multi-day spec |

**Benchmark plan (M4):**

- **A.** A **SWE-bench Lite subset**: 50 fixed instance IDs chosen with a published seed, run with the official Docker evaluation harness.
- **B.** A **"Jimmy set"**: 10 real tasks from your repos. For example: migrate a test runner, add types to a JS module, fix every lint error in a package, backfill tests to a coverage target, a dependency major upgrade. Each has a scripted acceptance check.
- **C.** **One long-horizon run**: a 40–60 item spec checklist with a test per item, run for 24–72 h.
- **Baselines on the same model wherever possible:** Claude Code headless (`claude -p --bare` with an API key, the same turn and budget caps, and a Ralph-style outer loop for C), mini-SWE-agent, Aider (`--architect --auto-test`), plus Codex CLI on its own model as an "industry" reference.
- **Decision rule (personal):** Omnexx becomes Jimmy's default for long runs **only if** it matches the best same-model baseline's resolve rate within 2 points **and** costs **at least 25% less per resolved task**, or clearly wins on the long-horizon run (C). Results, configs and raw logs go in `bench/results/`. They are for Jimmy's decisions and tuning, and the site makes no comparison claims. (Revised Oct 3.)
- **Extra arms:** worker backends off vs on (§15), and Nimble off vs advise vs steer (§13).

---

## 5. CLI design

### 5.1 Commands

| Command | What it does |
|---|---|
| `omnexx init` | Detects the package manager and gates, writes `omnexx.toml`, checks git and the key, and prints a summary. Asks before writing. |
| `omnexx run "<goal>"` | Starts a run. Flags: `--goal-file SPEC.md`, `--detach`, `--budget 40`, `--hours 72`, `--gate "npm test"` (repeatable), `--sandbox docker|host`, `--model-worker sonnet`, `--plan-only`, `--push branch`, `--from <ref>` |
| `omnexx status [runId] [--json]` | Phase, cycle, current task, tasks done/parked/total, last green SHA, spend versus budget, heartbeat age, ETA guess |
| `omnexx logs [runId] [-f] [--events|--progress|--cmd <id>]` | Human-readable stream, the raw JSONL, the journal, or a full command log |
| `omnexx plan [runId] [--edit]` | Shows the plan. `--edit` opens `goal.md` in `$EDITOR`, and the change is picked up next cycle. |
| `omnexx pause|resume|stop [runId] [--now]` | Writes `control.json`. Pause and stop take effect at the next turn boundary (`--now` aborts the current turn and rolls back). |
| `omnexx runs` | Lists runs with their status |
| `omnexx diff [runId]` | `git diff <start>..<lastGreen>` with stats |
| `omnexx service install|uninstall|status` | launchd/systemd unit for resuming on reboot |
| `omnexx doctor` | Node version, git, rg, docker (if sandbox=docker), key present (masked), network to the provider, a gate dry-run |
| `omnexx auth set|clear <provider>` | Stores the key in a 0600 file, read without echo |

Exit codes: `0` finished, `2` needs-human, `3` budget stop, `4` user stop, `1` error. `--json` everywhere for scripting.

### 5.2 Detached / daemon mode

- **Choice: a built-in detach plus an optional OS service; tmux isn't required.** `--detach` spawns `omnexx supervise <runId>` with `detached: true`, stdio redirected to `runs/<id>/supervisor.log`, and `unref()`, then prints the run ID and exits. Closing the terminal or SSH session doesn't touch it.
- `omnexx service install` adds reboot survival (launchd `KeepAlive`, or a systemd user unit with `Restart=on-failure` and linger).
- **Why not tmux-only:** it doesn't survive reboots, and you'd need a separate resume path anyway. **Why not one global daemon:** one supervisor per run is simpler to reason about, crash-isolated, and holds no shared state.
- **Control** goes through `control.json`, which the supervisor polls between turns. That's robust across crashes and needs no socket. `SIGTERM` means a graceful stop and `SIGINT` (when attached) means pause.

### 5.3 Config files

Precedence: **CLI flags > env (`OMNEXX_*`) > `./omnexx.toml` (project, committed) > `~/.config/omnexx/config.toml` (user) > defaults**. The format is TOML, which you edit by hand and which allows comments, validated by a **zod** schema that gives clear errors. Run state lives in `~/.omnexx/`, never in the repo.

```toml
# omnexx.toml (project)
setup   = ["npm ci"]
sandbox = "host"
protected = ["omnexx.toml", ".github/**", "*.lock", "package-lock.json"]

[[gates]]  # see §3.8
[budget]   # see §3.11
[models]   # see §3.14
[git]
push = "none"        # none | branch
open_pr = false
```

### 5.4 Install method: **`npm i -g omnexx`** (chosen)

**Why npm over `curl … | sh`:**

1. The CLI is TypeScript on Node, so Node is required anyway. npm is the native, cross-platform (macOS, Linux, WSL) way to install it, with versioning, `npm update -g`, uninstall and `npx omnexx` for trying it out.
2. **Supply-chain trust:** npm trusted publishing gives automatic **provenance attestations** tied to the GitHub workflow (https://docs.npmjs.com/trusted-publishers/). A `curl | sh` script is an extra unsigned thing to trust and host, and it would just call npm anyway.
3. **Nothing extra to host:** omnexx.org stays a single static file, with no binary hosting, checksums or install script to maintain.

`install.sh` can come later only if a standalone binary appears (for example via Node SEA or Bun compile).

### 5.5 Stack

- **TypeScript (strict) on Node ≥ 22 LTS**, developed on Node 24. ESM only.
- **Dependencies are kept small on purpose and each needs a reason:** `@anthropic-ai/sdk`, `commander` (CLI), `zod` (schemas), `smol-toml` (config), `execa` (child processes with timeouts and kill trees), `shell-quote` (command policy parsing), `picocolors`. Added later with a reason: `imapflow`, `nodemailer` and `mailparser` (the built-in email connector: IMAP, SMTP and message parsing, one maintainer, so users' mail passwords never go to a third-party MCP server). There's no LangChain-style framework. Git goes through the `git` binary via execa (no git library needed), and search through `rg` (checked by `doctor`, with a JS fallback).
- **Tooling:** `tsup` (or `tsdown`) for the build, `vitest` for tests, `eslint` + `typescript-eslint` (strict-type-checked), `prettier`. Package manager: **npm**, to match your infra conventions.

### 5.6 Release process

> **Demoted (Oct 3, personal use):** keep releases simple. Jimmy publishes by hand from a tag (`npm publish` with 2FA) or through a single small trusted-publishing workflow. Changesets, the Version-Packages bot, the post-publish smoke matrix and an alpha dist-tag are optional and only worth adding if releases become frequent. The steps below are the "full" version, kept for reference.

1. Conventional commits plus **changesets** for versioning and the changelog.
2. Merging to `main` makes CI build and test. The changesets bot opens a "Version Packages" PR.
3. Merging that PR tags `vX.Y.Z`. The `release.yml` workflow (GitHub-hosted runner, `permissions: id-token: write, contents: read`) runs `npm publish` through **trusted publishing** with automatic provenance and no long-lived npm token. It also creates a GitHub Release from the changelog.
4. Post-publish smoke job: `npm i -g omnexx@X.Y.Z` on clean ubuntu and macos runners, then `omnexx --version` and `omnexx doctor --offline`.
5. Pre-1.0: `0.x` with breaking changes allowed and noted. An `alpha` dist-tag goes out for M2–M3 builds.

---

## 6. Landing page (omnexx.org)

### 6.1 Exact copy

- `<title>`: **Omnexx: set a goal, walk away, come back to commits**
- `<meta name="description">`: *One coding agent that runs for days on its own, checks every step against your tests, and commits only what passes.*
- **Headline (h1):** **Set a goal. Walk away. Come back to commits.**
- **One-line pitch (p):** *Omnexx is one coding agent that runs for days without you, checks every step against your tests, and commits only what passes.*
- **Install box:** `npm i -g omnexx` with a **Copy** button (the label changes to "Copied" for 1.5 s).
- *Optional fine-print line under the box (recommended, since it prevents failed first runs):* `Requires Node 22+ and your own Anthropic API key.`
- **Link:** `GitHub →` pointing to `https://github.com/yaegerbomb42/omnexx`

Nothing else: no nav, no feature grid, no images, no signup.

### 6.2 Minimal static design spec

- A single `index.html` with inline CSS (< 2 KB) and inline JS (< 0.5 KB, only for the copy button using `navigator.clipboard.writeText`, falling back to selecting the text). **Total page under 10 KB.** No web fonts, frameworks or external requests.
- Layout: vertically centered column, `max-width: 640px`, generous whitespace. Dark background `#0b0d10`, text `#e7e9ee`, muted `#9aa3af`, one accent `#7c5cff` used for the copy button and link. System font stack for text, `ui-monospace` for the command.
- Install box: rounded 10 px, 1 px border `#2a2f3a`, the command on the left with a `$` prompt in muted color (not selectable, `user-select:none`), the Copy button on the right. Big tap target on mobile.
- Accessibility: AA contrast, visible `:focus-visible` rings, `aria-live="polite"` for "Copied", and a `prefers-reduced-motion` check (there's barely any motion anyway).
- Meta: OG/Twitter title and description (no OG image needed), `favicon.svg` (a simple "⟳"-style mark or the letters "ox"), `theme-color`.
- Lighthouse target: 100/100/100/100.

### 6.3 Deploying through the infra repo, following its conventions

**What exists today (found in `/Users/yaeger/Desktop/infra`, read-only):**

- Apps live in `infra/infra/apps/<name>/`. Deploy with `./infra/deploy.sh <name>` (v4.5, "Turbo Universal Deploy Script"). The VPS is `ubuntu@147.224.158.118`, with the repo mirrored at `~/infra/` there.
- `deploy.sh` has a **`PROJECT_CATALOG`** with the entry `"omnexx:app:8116:omnexx.org:Next.js/Fullstack:omnexx-app"` (name:category:port:domain:type:service).
- For a project **without** `.next/standalone`: if a `package.json` exists, the script runs `npm install` and `npm run build`, then copies `dist/` (or `client/dist/`) into `current/`. With no `package.json`, it copies only `index.html` and `assets/` (plus a few hard-coded extras) into `current/`. It then rsyncs `current/` to `~/infra/apps/<name>/current/` on the VPS and reloads the **`static-landings`** nginx container. A backend container is built only if `Dockerfile` or `server/Dockerfile` exists. Verification is `curl -H 'Host: <domain>' http://127.0.0.1:<port>/` on the VPS, which must return 200 or 3xx.
- `docker-compose.yml` service **`static-sites`** (`nginx:alpine`, container `static-landings`) already mounts `./apps/omnexx/current:/usr/share/nginx/html/omnexx` and publishes `8116:8116`. There's also an **`omnexx-server`** service (build `./apps/omnexx/server`, port 8117, `/api/health`).
- `nginx.conf` currently has `listen 8116; server_name omnexx.org www.omnexx.org _;` and **proxies to `omnexx-server:8117`**. The file starts with a global `sub_filter` that injects `https://yaeger.info/tracker.js` into every HTML `<head>`.
- **TLS** isn't in the repo. It's terminated by **Nginx Proxy Manager** (container `traffic-controller`, served as `openresty`) on ports 80/443 with Let's Encrypt. NPM's admin UI (`:81`) is locked to the tailnet by `host/npm-admin-lockdown.sh`. NPM proxy hosts forward to the internal ports, e.g. swarmagents.codes → `:8085`.
- **swarmagents** has its own deploy branch in `deploy.sh` (`deploy_swarmagents_v2`): local typecheck, then render and auth gates, rsync of the source, a separate compose project `swarmagents-v2`, **nginx.conf synced with a backup, `nginx -t`, then reload (or restore)**, an image built on the VPS, a preflight container on `127.0.0.1:3499`, a container swap, and an egress firewall. The **generic path only syncs `nginx.conf` in its backend step**, and it **reloads without running `nginx -t`**.

**Problems to fix first (found during the review):**

1. **`infra/apps/omnexx/` currently holds the DWEEBS game** (`package.json` name `"dweebs"`, Vite/Rapier, a `Dockerfile` for `dweebs-server`), and **https://omnexx.org currently serves "DWEEBS — Knockout Brawl"**, including a **service worker at `/sw.js`**. Meanwhile `apps/dweebs/` doesn't exist locally, even though the catalog, compose (`dweebs-server` context `./apps/dweebs`) and nginx (`:8120`) all expect it. *Proposed:* move the DWEEBS source to `infra/apps/dweebs/`, deploy with `./infra/deploy.sh dweebs`, and confirm dweebs.yaeger.info. **Jimmy decides (§11).**
2. **`www.omnexx.org` fails TLS** ("unrecognized name"). DNS has `www CNAME omnexx.org`, but the Let's Encrypt certificate only covers `omnexx.org`.
3. Smaller things: the catalog says `Next.js/Fullstack:omnexx-app`, but compose calls the service `omnexx-server`, and DEPLOY.md says `omnexx-app / static-sites`.

**Files and config to add or change in the infra repo (later, in M5, with your approval):**

| File | Change |
|---|---|
| `infra/apps/omnexx/index.html` | The landing page (§6.1–6.2) |
| `infra/apps/omnexx/public/favicon.svg` | Icon |
| `infra/apps/omnexx/public/sw.js` | **Kill-switch service worker** that unregisters itself and clears caches, so visitors who installed DWEEBS's worker see the new page. Keep it ~6 months. |
| `infra/apps/omnexx/public/robots.txt` | `User-agent: * / Allow: /` |
| `infra/apps/omnexx/package.json` | `{"name":"omnexx-site","private":true,"scripts":{"build":"rm -rf dist && mkdir -p dist && cp index.html dist/ && cp -R public/. dist/"}}` with **no dependencies**. This uses deploy.sh's existing `package.json → dist/ → current/` path, so `sw.js` and `robots.txt` ship (the no-package.json path only copies `index.html` and `assets/`), and the content hash covers `public/` and `index.html`. |
| *(must not exist)* | No `Dockerfile`, `Dockerfile.standalone`, `server/Dockerfile`, `.next/`, `dashboard/` or `site/package.json` in `apps/omnexx/`. Each of these changes deploy.sh's behavior. |
| *(cleanup)* | Empty the stale `apps/omnexx/current/` and `apps/omnexx/dist/` (DWEEBS build output) before the first deploy. Locally the script does `rsync -a dist/ current/` **without `--delete`**, so old files would ship otherwise. |
| `infra/infra/nginx.conf` | Replace the `:8116` block with a static server (below). |
| `infra/infra/docker-compose.yml` | Remove the `omnexx-server` service (8117). The `static-sites` mount and the `8116` port already exist. |
| `infra/infra/deploy.sh` | Change the catalog line to `"omnexx:app:8116:omnexx.org:Static:static-sites"`. *Recommended small hardening:* make the generic static path sync `nginx.conf` with the same backup, `nginx -t` and restore steps the swarmagents branch uses. |
| `infra/DEPLOY.md` | Update the omnexx row: `apps/omnexx · 8116 · omnexx.org · Static landing (CLI install) · static-sites` |

Proposed `nginx.conf` block (config, shown for review):

```nginx
# Omnexx (omnexx.org) (Port 8116): static landing page for the omnexx CLI
server {
    listen 8116;
    server_name omnexx.org www.omnexx.org _;
    root /usr/share/nginx/html/omnexx;
    index index.html;
    absolute_redirect off;
    port_in_redirect off;

    # Optional: opt out of the global tracker injection (open question §11)
    # sub_filter '<head>' '<head>';

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://yaeger.info; img-src 'self' data:; connect-src 'self' https://yaeger.info; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;

    location = / {
        add_header Cache-Control "no-cache" always;
        try_files /index.html =404;
    }
    location = /sw.js {                      # kill-switch must never be cached
        add_header Cache-Control "no-store" always;
        add_header Service-Worker-Allowed "/" always;
    }
    location / { try_files $uri =404; }
}
```

(If you opt out of the tracker, drop `https://yaeger.info` from the CSP.)

**TLS (Nginx Proxy Manager, through the tailnet admin UI on `:81`, not in the repo):**

1. Open the existing proxy host for `omnexx.org`. Confirm it forwards to the `static-landings` port 8116 the same way the other static sites do (e.g. `172.17.0.1:8116`).
2. **Add `www.omnexx.org`** to the domain names, then request a new Let's Encrypt certificate covering both names. Turn on **Force SSL**, **HTTP/2** and **HSTS** (no preload until it's stable).
3. Optional: redirect www → apex (a 301 in NPM's advanced config, or leave both serving).

**Deploy order (M5):** publish `omnexx@0.1.0` to npm **first**, so the install command works on day one. Then:
1. Move DWEEBS and deploy it.
2. Ship the nginx/compose changes. The `dweebs` deploy syncs `nginx.conf` in its backend step, or use the hardened static path.
3. Run `./infra/deploy.sh omnexx --dry-run`, then `./infra/deploy.sh omnexx`.
4. Update NPM's SSL settings.
5. Verify:
   - `curl -sI https://omnexx.org` → 200 with the new `<title>`
   - `curl -sI https://www.omnexx.org` → 200 or 301
   - `/sw.js` returns the kill-switch
   - a phone that previously visited sees the new page after one reload

---

## 7. Repo plan: `yaegerbomb42/omnexx` (new, public)

Doesn't exist yet: `github.com/yaegerbomb42/omnexx` returns 404. The npm name `omnexx` is **unclaimed** (`registry.npmjs.org/omnexx` → 404). Reserve both early.

### 7.1 Layout

```
omnexx/
├─ package.json            # "bin": {"omnexx": "dist/cli.js"}, engines.node >= 22, type: module
├─ tsconfig.json           # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├─ eslint.config.js  .prettierrc  vitest.config.ts  tsup.config.ts
├─ README.md  LICENSE  SECURITY.md  CONTRIBUTING.md  CHANGELOG.md
├─ .changeset/
├─ .github/workflows/ci.yml  release.yml  nightly-e2e.yml
├─ docs/  architecture.md  config.md  safety.md  benchmarks.md
├─ src/
│  ├─ cli/            index.ts, commands/{init,run,status,logs,plan,control,runs,diff,service,doctor,auth}.ts
│  ├─ core/           supervisor.ts, cycle.ts, phases.ts, run-store.ts (atomic state), lock.ts, events.ts, heartbeat.ts, control.ts
│  ├─ agent/          loop.ts, engine.ts (interface), prompts/{system,planner,worker,summarize}.md, context.ts (prefix+cache breakpoints), compaction.ts, repo-map.ts
│  ├─ tools/          read.ts, outline.ts, search.ts, edit.ts, bash.ts, read-log.ts, remember.ts, plan-tool.ts, registry.ts
│  ├─ verify/         gates.ts, baseline.ts, ratchet.ts, anticheat.ts, flaky.ts, parsers/{vitest,jest,pytest,gotest,tsc,eslint,generic}.ts
│  ├─ git/            worktree.ts, checkpoint.ts, rollback.ts, trailers.ts, reconcile.ts
│  ├─ guard/          budget.ts, stuck.ts, signatures.ts, strategy-ladder.ts
│  ├─ providers/      types.ts, anthropic.ts, openai-compat.ts, pricing.ts, retry.ts
│  ├─ security/       paths.ts (jail), command-policy.ts, env-scrub.ts, redact.ts, sandbox-docker.ts
│  ├─ notify/         ntfy.ts
│  ├─ daemon/         detach.ts, launchd.ts, systemd.ts
│  └─ config/         schema.ts, load.ts, defaults.ts
├─ test/
│  ├─ unit/           (mirrors src/)
│  ├─ integration/    scripted-provider loop tests on fixture repos
│  ├─ chaos/          kill -9 at every phase, then resume
│  ├─ e2e/            real API, gated by OMNEXX_E2E=1 and a $ cap
│  └─ fixtures/repos/ ts-failing-test, flaky-suite, impossible-task, oscillation, test-deleter, big-file, secrets-in-env
└─ bench/
   ├─ tasks/jimmy/*.toml     # task + acceptance script
   ├─ swebench/lite-50.txt   # fixed instance IDs + seed
   ├─ runners/{omnexx,claude-code,mini-swe-agent,aider,codex}.ts
   └─ results/               # committed tables + configs (raw logs as release artifacts)
```

### 7.2 Testing strategy

- **A scripted provider is the backbone.** It's a fake `Provider` that replays recorded or hand-written model responses (tool calls included), so the **whole harness** (cycle, gates, commit, rollback, stuck ladder, budget, resume) is tested deterministically, offline and for free. Each fixture repo has a scenario script.
- **Unit tests** cover pure logic: the ratchet diff, failure-signature normalization, stuck signals, budget math, the pricing table, redaction patterns (with a corpus of fake tokens), the path jail (traversal, symlinks, case tricks on macOS), the command-policy parser, config precedence, and trailer parsing.
- **Chaos tests:** a harness that runs a scenario and `SIGKILL`s the supervisor at a random phase N times (20 per CI run, 200 nightly). After each kill it runs `resume` and checks the invariants: no lost green commit, no duplicate commit, a clean worktree at cycle start, `state.json` consistent with `git log`, and exactly one supervisor.
- **Safety tests:** the agent tries to `cat ~/.ssh/id_ed25519`, `rm -rf ../`, `git push --force`, print `$ANTHROPIC_API_KEY`, or write outside the worktree. Every attempt must be refused and logged, with nothing leaking into events, logs or ntfy payloads.
- **E2E:** with a real Anthropic key, three small fixture tasks run nightly with a $2 cap, asserting a solved state and a cache-hit ratio above threshold.
- **Coverage gate:** at least 85% lines in `core/`, `verify/`, `guard/`, `security/` and `git/`. Other folders aren't gated, so coverage doesn't get padded with fluff.

### 7.3 CI (GitHub Actions)

- `ci.yml` on PRs and pushes: a matrix of `ubuntu-latest` and `macos-latest` × Node 22 and 24. Steps: `npm ci`, lint, typecheck, unit + integration + chaos (20), build, `npm pack`, then install the tarball globally and run `omnexx --help` and `omnexx doctor --offline`.
- `nightly-e2e.yml`: real API e2e (repo secret, $2 cap) plus chaos (200).
- `release.yml`: changesets → tag → trusted publish (§5.6).
- Branch protection on `main`: CI required and linear history.

---

## 8. Milestones and acceptance criteria

### M0: Skeleton
**Scope:** repo, toolchain, CLI skeleton, config, `init`, `doctor`, CI.
**Acceptance:**
- CI is green on ubuntu and macos × Node 22 and 24. Lint and typecheck are strict with zero warnings.
- `omnexx --help` and `--version` work. `omnexx init` in a sample repo detects the package manager and gates, writes `omnexx.toml` after confirmation, and is idempotent.
- `omnexx doctor` reports Node, git, rg, the key (masked) and docker when configured. It never prints a key, and a unit test proves that.
- Config precedence and zod validation errors are tested, and bad config produces a one-line, actionable error.
- `npm pack` produces a tarball that installs globally and runs. Runtime dependencies match the approved list in §5.5 exactly.

### M1: Single-session agent loop
**Scope:** the Anthropic provider (caching, retries, usage accounting), tools (read/outline/search/edit/bash/read_log/remember), path jail, command policy, env scrubbing, redaction, the worktree, **one cycle**: act → gates → commit or rollback, the event log, and `run --plan-only`.
**Acceptance:**
- With the scripted provider, the `ts-failing-test` fixture ends with one checkpoint commit on `omnexx/<runId>` and trailers present. The `impossible-task` fixture ends rejected with the worktree byte-identical to `lastGreen`.
- With the real API (e2e), "make the failing test pass" in the fixture is solved in one cycle for under $0.50, and **cache-read share is ≥ 60%** of input tokens from turn 3 on.
- The ratchet holds: a fixture with a pre-existing failing test still accepts a cycle that fixes the target test without fixing the old one.
- The anti-cheat test passes: the `test-deleter` scenario is rejected.
- All safety tests pass. Grepping all logs and events for the secret corpus finds zero hits.
- Your checkout stays untouched: `git status` and HEAD of the original repo are unchanged during and after the run.

### M2: Durability and resume
**Scope (revised Oct 3, personal-use priorities added):** the multi-cycle supervisor, a cycle 0 planner that writes a **hierarchical plan** (§14.1), the **codebase map** (§14.2), **milestone checkpoints** (§14.3), the **morning-after report** (§14.4), `plan.json` / `progress.md` / `notes.md`, the phase machine with atomic state, lock, reconcile, `--detach`, `pause/resume/stop`, `status/logs/runs/diff`, heartbeat, ntfy, `service install` (launchd plus systemd), and network-outage backoff.
**Acceptance:**
- The chaos suite (20 in CI, 200 nightly) passes every invariant in §7.2.
- A simulated reboot (stop the service, wipe the PID, start the service) resumes from the correct phase within 60 s with no repeated commits.
- After `run --detach`, closing the terminal leaves the run going. `status` shows a heartbeat newer than 30 s. `pause` takes effect within one turn and `resume` continues.
- Editing `goal.md` mid-run is picked up next cycle and logged by hash.
- ntfy pushes (against a mock server in CI) carry only the allowed fields, and redaction tests cover them.
- A scripted 30-task scenario runs to completion across 3 forced kills and one 10-minute simulated API outage, with zero manual steps.
- The hierarchical plan, codebase map, milestone checkpoints and morning-after report behave as specified in §14 (scripted-provider tests).

### M3: Long-run guardrails, stuck detection and worker backends
**Scope:** budgets (total, daily, hours, cycles, per cycle), pre-flight cost estimates, every stuck signal, the strategy ladder (including the new "second opinion" rung, §15.5), model routing (planner/worker/cheap), in-cycle compaction and tool-result clearing, flaky handling, protected paths, `sandbox = "docker"`, and **real worker-backend adapters** (§15). M0–M2 ship only the `WorkerBackend` interface, its types and a fake worker for tests.
**Acceptance:**
- Stuck fixtures behave as specified: `impossible-task` is parked after the configured rungs, `oscillation` is caught within one cycle, `flaky-suite` doesn't trigger a false rollback and the flaky test is recorded.
- A budget cap is never exceeded by more than one turn's cost (property test plus e2e). The daily cap pauses the run and it resumes after the window rolls (simulated clock).
- **Worker backends:** every enabled adapter passes its contract tests against a recorded or fake CLI. A worker result goes through the exact same VERIFY/JUDGE path as a native cycle. A timed-out worker is killed with its whole process tree. Quota exhaustion rotates to the next eligible worker. No credentials appear in logs or events (§15.7).
- **A 24-hour soak** (revised from 48 h): a real-API run on a 40-item spec-checklist fixture runs on the VPS (or your Mac) in docker sandbox mode for 24 h. It ends `finished` or `finished-with-parked`, with zero human input, zero manual restarts, at least 90% of items done, and spend under its budget. The run report is committed to `bench/results/soak-*.md`.
- Docker sandbox mode passes the safety suite and respects the CPU and memory limits.

### M4: Efficiency benchmark
**Scope:** `bench/` runners, the SWE-bench Lite-50 subset, the Jimmy set of 10, one long-horizon spec, baselines (Claude Code headless on the same model, mini-SWE-agent, Aider, plus Codex as a reference), and the optional `claude-agent-sdk` engine.
**Acceptance:**
- One command reproduces it: `npm run bench -- --suite lite50 --agents omnexx,claude-code`. Configs, seeds and model IDs are pinned in `bench/results/<date>/`.
- A results table with every metric in §4.7, with raw logs attached to a GitHub release.
- **The decision rule is applied:** "more efficient" is claimed only if it's within 2 points on resolve rate and at least 25% lower in $ per resolved task than the best same-model baseline. Otherwise the gaps go into tuning issues and the claim stays off the site.

### M5: Site and release
**Scope:** README and docs, `0.1.0` on npm (published by hand or through one small trusted-publishing workflow; see §5.6), and the omnexx.org deploy following §6.3. Kept simple: personal use.
**Acceptance:**
- On clean macOS and Ubuntu, `npm i -g omnexx` → `omnexx --version` → `omnexx init` → `omnexx run --plan-only "…"` works with an API key. A provenance badge shows on npmjs.com.
- https://omnexx.org and https://www.omnexx.org both serve the new page over valid TLS. Lighthouse 100 across the board, page under 10 KB. The copy button works on iOS Safari and Chrome.
- The DWEEBS service worker is gone: a device that previously visited sees the new page after one reload. DWEEBS still works at its new home.
- `./infra/deploy.sh omnexx` passes its gateway verification, and `deploy.sh --list` and DEPLOY.md reflect "Static".

---

## 9. Future use case: the "ops agent"

The same harness can run **unattended daily loops** for operations work. A `kind = "ops"` run changes only the policies:

- **Schedule:** cron-like (`schedule = "0 7 * * *"`) instead of running until done. The service unit triggers one cycle per tick.
- **Example jobs:**
  - Check your sites (swarmagents.codes, yaeger.info, omnexx.org…) for HTTP status and TLS expiry. NPM certificates expire silently.
  - Summarize `deploy.log` and container restarts.
  - Weekly cost report from the LiteLLM proxy.
  - Dependency and CVE scans of the repos.
  - Draft a weekly update.
- **Tools:** read-mostly (HTTP GET, `docker ps`/logs over a read-only SSH key, git read), plus `write_draft(path)`.
- **Verification:** schema checks on outputs (the report has all sections, numbers parse, links resolve) instead of tests.
- **Output:** files in `~/omnexx-ops/<date>/` plus an ntfy digest.
- **Hard rule:** it drafts and never sends. There are no email, Slack, post, ticket or deploy tools. Anything that goes out is reviewed and sent by you.
- **Budget:** a small per-day cap (e.g. $1/day) on the cheap model, escalating only on anomalies.

This is **out of scope for M0–M5** and is kept in mind only through the `kind` field and pluggable tool registry, so it doesn't need a rewrite later.

---

## 10. Risks (short)

| Risk | Mitigation |
|---|---|
| Runaway spend over days | Hard budgets, pre-flight estimates, daily cap that pauses, an 80% ntfy warning |
| Gaming the judge (deleting or skipping tests) | Ratchet, anti-cheat checks, protected paths, test-count invariant |
| Destructive commands while unattended | Worktree isolation, path jail, AST-parsed command policy, docker sandbox mode, no keys in the agent's environment |
| Runs on the VPS starving production sites | Docker CPU and memory limits, `nice`/`ionice`, or run on the Mac. Your call (§11). |
| API or model churn (IDs, compaction and edit types) | Aliases plus the pricing table in config, feature flags for edit types, nightly e2e |
| "More efficient" turning out false | The M4 decision rule. Don't claim it until it's measured. |
| Scope creep (multi-agent, UI, cloud, public-product features) | Explicit non-goals: one agent in charge, CLI only, local or self-hosted, personal use |
| Worker backends breaking third-party terms or leaking credentials | Opt-in per worker, all off by default, Omnexx never reads or logs worker credentials, quota caps, and a ToS warning in `doctor` and the docs (§15.7) |
| A worker (with its own auto-approve) doing something destructive | Isolated worktree per attempt, pushes disabled through git config overrides, ref-tamper check after each run, docker sandbox recommended, and the result is only a candidate diff (§15.4) |

## 11. Open questions for Jimmy

1. **DWEEBS currently lives in `infra/apps/omnexx/` and is what omnexx.org serves.** OK to move it to `infra/apps/dweebs/` (dweebs.yaeger.info) and repurpose omnexx.org for the landing page?
2. **Tracker:** keep the global `yaeger.info/tracker.js` injection on omnexx.org, or opt this site out?
3. **ntfy:** `ntfy.sh/yaeger` is public and guessable. Keep it (pushes carry no sensitive data), or switch to a random suffix or a token-protected topic?
4. ~~Where do runs live~~ Decided: the Oracle VPS (systemd first); Nimble runs on the Mac. Original question: your Mac (sleeps, so it needs `caffeinate`), the Oracle VPS (always on, but shared with production), or both?
5. **Default budgets:** revised to one ~24 h run: $50, 24 h, 300 cycles, an 8% wrap-up reserve (§14.5). Right for you?
6. ~~License~~ Decided: MIT.
7. ~~Reserve the npm name and repo~~ Done: the repo exists; a 0.0.1 placeholder is ready to publish.
8. Should the `claude-agent-sdk` engine (Claude Code's loop inside Omnexx's harness) be a first-class option, or a benchmark baseline only? (Partly covered by the `claude-code` worker backend, §15.)
9. **Workers:** which workers should be enabled first, and in what priority order? Which of their free tiers are you comfortable automating, given the terms-of-service risk (§15.7)?

---

## 12. Handoff prompt for Claude Code (builds M0–M2)

> **Superseded:** the current handoff is `~/Desktop/omnexx-claude-handoff.md`. It covers M0–M2 plus the §13–§15 additions and the landing page. The prompt below is kept for history.

> Before starting, create an empty folder (e.g. `~/code/omnexx`), `git init`, save this whole plan as `docs/PLAN.md`, then open Claude Code there and paste:

```text
You are building Omnexx, a TypeScript/Node CLI that runs ONE coding agent for days
without human steering. The full, authoritative plan is in docs/PLAN.md. Read it
completely before writing any code. Your job in this session: deliver milestones
M0, M1 and M2 exactly as specified in PLAN.md §8, in that order.

HOW TO WORK
- Work as one agent. No sub-agents and no parallel branches. Finish and verify each
  milestone before starting the next.
- Before each milestone, write docs/milestones/M<n>.md: scope, the design for each
  module, the files to create, and how each acceptance criterion will be proven.
  Then implement. When done, fill in an "Evidence" section (commands run and results).
- After every meaningful step: npm run lint && npm run typecheck && npm test &&
  npm run build. Small, focused commits with conventional messages
  (feat:, fix:, test:, chore:, docs:). Never commit with red checks.

QUALITY BAR (non-negotiable)
- No boilerplate, placeholders, TODO stubs, dead code, `any`, or swallowed errors.
  Every module has a clear single responsibility and typed interfaces (see the
  PLAN.md §7.1 layout). Errors are typed and actionable.
- tsconfig strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes. ESM. Node >= 22.
- Tests come with the code, not after. A scripted fake Provider drives
  deterministic integration and chaos tests (PLAN.md §7.2). Coverage >= 85% on
  src/core, src/verify, src/guard, src/security, src/git.
- Record every non-obvious decision in docs/decisions.md (date, decision, why,
  alternatives considered).

DEPENDENCIES (runtime, approved list only; ask before adding anything else)
@anthropic-ai/sdk, commander, zod, smol-toml, execa, shell-quote, picocolors.
Dev: typescript, tsup, vitest, @vitest/coverage-v8, eslint, typescript-eslint,
prettier, @changesets/cli.

SCOPE
- M0: repo skeleton, toolchain, CI workflow (ubuntu+macos × Node 22/24), CLI with
  --help/--version, config schema + loader with precedence, `omnexx init`,
  `omnexx doctor` (never prints keys), npm pack smoke test.
- M1: Anthropic provider (prompt caching with stable prefix + breakpoints, retries,
  usage/cost accounting from a pricing table), tools (read with ranges, outline,
  search via rg, str_replace edit, bash under command policy, read_log, remember),
  path jail, env scrubbing, redaction, git worktree on branch omnexx/<runId>, one
  full cycle: act -> gates -> ratchet + anti-cheat -> commit with trailers OR
  rollback to lastGreen. Event log (JSONL). `run --plan-only`.
- M2: multi-cycle supervisor, cycle-0 planner, goal.md / plan.json / progress.md /
  notes.md, phase machine with atomic state writes + lockfile + reconcile on start,
  --detach, pause/resume/stop via control file, status/logs/runs/diff, heartbeat,
  ntfy (allow-listed fields only, redacted), `service install` for launchd and
  systemd --user, API-outage backoff. The chaos suite must pass.
All acceptance criteria for M0–M2 in PLAN.md §8 must be demonstrably met.

HARD RULES
- Tests never hit the network or need an API key. Real-API e2e tests run only
  when OMNEXX_E2E=1 is set, with a hard $ cap.
- Never print, log, commit or echo secrets or env values. Never read ~/.ssh,
  ~/.aws, keychains, or any .env file outside test fixtures.
- Do NOT npm publish, create GitHub releases, push to any remote, deploy anything,
  or touch ~/Desktop/infra. No destructive commands outside this repo.
- If PLAN.md is ambiguous, pick the simplest option consistent with it, record it
  in docs/decisions.md, and continue. Stop and ask only if a choice would violate
  a hard rule or change the public CLI surface.

FINISH WITH A REPORT
A table of every M0–M2 acceptance criterion -> met / not met + evidence (test name
or command output), the coverage summary, known gaps and risks, and the exact
commands I can run to try it locally (npm link; omnexx init; omnexx run --plan-only ...).
```


---

## 13. Addendum (Oct 3, 2026): optional "fast judge" (Nimble via Ollama, usually remote on the Mac)

**Decision (Jimmy):** add an optional, advisory decision layer using Bespoke Labs' **Nimble 9B** decision model served by Ollama (https://ollama.com/library/nimble). It is **off by default** and **never replaces the gates**: tests, typecheck and lint stay the final judge of every cycle.

**Where it runs:** Nimble does **not** run on the Oracle VPS. It runs, optionally, on Jimmy's Mac (36 GB RAM, Ollama 0.35.0 installed). A run on the VPS reaches it over **Tailscale**, so the adapter talks to a **remote** Ollama endpoint configured as `judge.nimble.url` (e.g. `http://<mac-tailnet-name>:11434`). The Mac may be asleep, offline or busy, so every call must **fail open**: if Nimble is unreachable or slow, the run continues without it and the miss is logged.

**What Nimble is:** a 9B decision model (fine-tuned from Qwen3.5-9B, Apache-2.0) that answers *typed* questions about a piece of text with probabilities and no reasoning step.
- Endpoint: `POST <url>/v1/systemone` with `{model: "nimble", state, questions, keep_alive?}`. `state` is a string or JSON value. `questions` is 1–64 named questions per call.
- Question types: `choice` (2–26 options; returns `choice`, `probabilities`, `confidence`), `noul` (true/false; returns the probability that the answer is true), `score` (ordered rubric of 2–26 levels; returns a probability-weighted `score`, `probabilities`, `confidence`).
- Under ~100 ms per call on Apple silicon (plus network latency when remote), ~9 GB RAM, **8,192-token prompt limit** (the full state plus every question must fit), request bodies up to 64 KiB, needs **Ollama ≥ 0.35**. Public-benchmark accuracy is ~75–80% (choice/boolean ~80%, rubric scores much lower).
- `confidence` measures how concentrated the probabilities are, **not** the chance the answer is right. Thresholds must be calibrated on our own data.

**Design:**
- A `Judge` interface (`src/judge/`) with three implementations: `none` (default, no calls), `nimble` (HTTP adapter, plain `fetch`, no new dependency) and `llm` (the `cheap` model role answering the same typed questions through a forced tool call; costs money, so it is opt-in too). `fallback` names what to use when the primary fails.
- **Fail-open with a half-open circuit breaker:** a per-call timeout (default 3 s, since the endpoint is usually remote), connection errors, HTTP errors, malformed answers or an Ollama version below 0.35 make the judge return "abstain" and log `judge.miss` with the reason. After several consecutive misses the breaker opens (no calls, logged `judge.unavailable`) and re-probes on a schedule (default every 10 min), so a Mac that wakes up mid-run is picked up again. **The run always continues.**
- **Advisory only:** a judge answer can add evidence to the next cycle's context, feed the stuck detector as a *secondary* signal, or be logged. It can never accept a cycle that failed the gates, never reject a cycle that passed them, never allow a command the command policy denies, and never override a budget stop.
- **Logging:** every call writes a `judge.decision` event (use, question IDs, answer, probabilities, confidence, latency, model, input size, endpoint host) through the normal redaction filter. Misses write `judge.miss`.
- **Input discipline and privacy:** the harness builds `state` deterministically, **redacts it first**, and trims it to fit the 8K-token / 64 KiB limits. Because state crosses the network to the Mac, only compact summaries go out (never whole files, env values or logs). Ollama has no auth of its own: bind it to the Mac's Tailscale address (or use Tailscale ACLs), never `0.0.0.0` on an untrusted network. `doctor` warns when `url` is neither loopback nor a Tailscale address (100.64.0.0/10 or `*.ts.net`).

**Primary use: the next-move decision.** At each cycle boundary (after RECORD, inside GUARD), the harness serializes a compact **agent-state summary**: goal (trimmed), current task and its attempt count, the last gate/test result, recent failure signatures, diff stats, approaches already tried, and budget left (USD, cycles, hours). It asks Nimble one `choice` question over the next-move options:

| Option | Meaning |
|---|---|
| `continue` | Keep going on the current task |
| `retry_different_approach` | Roll back and retry with an approach not in `approachesTried` |
| `split_task` | Re-plan: split the task into smaller tasks |
| `revert_to_last_green` | Discard partial work and restart the task from `lastGreen` |
| `switch_to_strong_model` | Escalate this task to the planner model |
| `park_and_move_on` | Park the task with a reason and pick the next runnable one |
| `ask_human` | Stop with `needs-human` and notify |

The probabilities, the pick, the harness's own rule-based decision and the final action are all logged. **The harness's rules can always override the pick.** Two modes: `advise` (default when enabled: log only, and record agreement with the rules) and `steer` (take the pick only when its probability clears a threshold, the action is in the set the rules currently allow, and the action is implemented; otherwise use the rule decision and log why). Hard stops (budget, user stop, run-level no-progress timer) always win. Options whose action ships in a later milestone stay in the question so the data is comparable over time; if picked before the action exists, the event is logged as `unavailable` and the rule decision applies.

**Other uses:**

| Use | Question shape | Milestone | Effect |
|---|---|---|---|
| **Next-move decision** (primary) | `choice` over the 7 options above | M2 (`advise`/`steer`) | As described above |
| Goal-drift check on each diff | `noul`/`score`: does this diff serve the current task and goal? | M2 | Logged; a confident "drifting" adds a note to the next cycle's evidence and a secondary stuck signal |
| Same-failure / oscillation similarity | `noul`: same root cause as the previous failure? does this diff undo an earlier accepted change? | M2 | Secondary signal next to the deterministic failure-signature and content-hash checks; never parks a task by itself |
| Pre-execution tool-call safety | `noul`: could this tool call cause harm outside the task? | M2 (log-only) | Logged; the AST command policy stays authoritative. A blocking mode is considered only after M4 data. Skipped while the breaker is open, so tools never wait on the Mac |
| Routing between cheap and strong model | `choice`: worker vs planner for this task/turn | M3 (with model routing) | Suggests the role; budget and the strategy ladder still decide |

**Config:**

```toml
[judge]
kind     = "none"      # none | nimble | llm
fallback = "none"      # none | llm
mode     = "advise"    # advise | steer (next-move decision only)
steer_min_probability = 0.6
uses     = ["next_move", "drift", "failure_similarity", "tool_safety"]

[judge.nimble]
url        = "http://localhost:11434"   # e.g. http://yaegers-mac.<tailnet>.ts.net:11434 from the VPS
model      = "nimble"
timeout_ms = 3000
keep_alive = "30m"
breaker_failures = 3
breaker_reprobe  = "10m"
```

`omnexx doctor` reports the endpoint, whether it's reachable, the Ollama version, whether the `nimble` model is pulled, and a round-trip latency when `kind = "nimble"`. With the judge enabled but the endpoint down, `doctor` warns and `run` still starts.

**Testing:** a mock `/v1/systemone` server on 127.0.0.1 (no external network). Tests cover: judge off → zero HTTP calls; every failure mode (refused, timeout, 5xx, malformed body, old Ollama) → run continues and `judge.miss`/`judge.unavailable`/fallback is logged; the breaker re-probes and recovers on a simulated clock; the state summary always fits the 8K-token / 64 KiB limits (property test over large synthetic histories) and contains no secrets; and an invariant test where the same scripted scenario run with the judge returning arbitrary answers in `advise` mode produces **exactly the same commits and rollbacks** as with the judge off.

**M4 benchmark:** add `judge = none` vs `judge = nimble (advise)` vs `judge = nimble (steer)` arms on the same suites and model. Report resolve rate, $ per resolved task, cycles to detect stuck/oscillation, next-move agreement with the rules, and the precision/recall of drift and safety flags against labeled outcomes. Nimble stays off by default unless the numbers show a win.

---

## 14. Personal-use focus: making one huge ~24 h run succeed (revised Oct 3)

Omnexx is for Jimmy. Success means: he hands it one **huge** task in the evening and comes back to a long trail of green commits, an honest report, and a run that stayed on track the whole time. Everything in this section takes priority over public-product polish.

### 14.1 Hierarchical plan

- `plan.json` becomes a tree: **goal → milestones → tasks** (and optional **steps** inside a task, used only as hints in the cycle prompt). Every node has `id` (stable, e.g. `M2.T07`), `parentId`, `title`, `why`, `acceptance[]`, `status`, `dependsOn[]`, `size` (`S`/`M`/`L`), `kind` (`feature`/`tests`/`lint`/`refactor`/`migration`/`docs`/`investigate`), `attempts` and `approachesTried[]`.
- **Leaf tasks** are what cycles execute (≤ ~1–2 h of agent work each). **Milestones** have their own acceptance checks (typically a broader gate run or a group of tests). A milestone is `done` only when all of its children are done **and** its own checks pass on `lastGreen`.
- The planner writes milestones first, then expands **only the next one or two milestones** into leaf tasks ("rolling-wave" planning). Later milestones stay coarse until they're reached. That keeps the plan accurate as the code changes, and keeps re-planning cheap.
- Re-planning (stuck rung 3, goal edits, or a milestone's checks failing after its children are done) may split, add or reorder nodes under the affected milestone. It may **never delete** a node; it can only park one with a reason.
- The cycle context shows a **compact plan view**: the goal, all milestone titles with status, the current milestone's tasks, and the full current task. It never shows the whole tree.

### 14.2 Sharper long-horizon memory

- **Lessons file (`notes.md`)**, as in §3.3, with a hard cap (~1.5k tokens) and add/replace/remove by ID. Entries are typed (`env`, `convention`, `pitfall`, `command`, `flaky`) and dated. At milestone boundaries the cheap model proposes a consolidation (merge duplicates, drop stale entries). It's applied only if the result is shorter and keeps every `env`/`command` fact.
- **Codebase map (`codemap.md` plus `codemap.json`)** under the run's state directory: a tree of the modules that matter, with one-line purposes, key exports/symbols, entry points, test locations and "how to run X". It's built in cycle 0 and **updated incrementally after every accepted commit** for the files that commit touched: deterministic symbol extraction, plus cheap-model one-liners only for new or changed files. It's capped (~3k tokens) and placed in the cached prefix instead of the raw repo map.
- **Per-task memory:** `approachesTried[]`, the last failure signatures and the rejected-patch summaries stay attached to the task node and are fed back on retry, so the agent never repeats a dead end.
- **No transcript memory.** Each cycle still starts fresh (§3.4). Memory lives only in these compact files.

### 14.3 Checkpoints

- Every accepted cycle is a commit with trailers (§3.3, §3.7). In addition, each **completed milestone** gets a lightweight tag `omnexx/<runId>/<milestoneId>`, and a "safe point" record in `state.json`.
- `omnexx checkpoints [runId]` lists milestone checkpoints with commit, time, tests passing and spend so far. `omnexx diff --since <milestoneId>` shows progress since a checkpoint.
- If a later milestone's acceptance reveals that an earlier accepted commit broke something the gates didn't cover, the harness can roll back to the last milestone checkpoint, but **only** through the strategy ladder and only within the run worktree. It's logged and shown in the report.

### 14.4 Morning-after report

- `omnexx report [runId]` writes `REPORT.md` in the run's state dir, and it's generated automatically when a run finishes, stops or needs a human. It's the first thing Jimmy reads. It contains:
  1. **Outcome:** finished / finished-with-parked / needs-human / budget-stop, the reason, and the wall-clock time.
  2. **Milestones and tasks:** a done/parked/todo tree with one line each. Parked tasks include the reason and the approaches tried.
  3. **What changed:** the branch, commit count, a diffstat by directory, and the notable commits.
  4. **Test and gate deltas:** baseline versus final, with new tests added and any known failures fixed.
  5. **Where it struggled:** stuck events, ladder rungs used, rollbacks, flaky tests, and worker attempts and outcomes (§15).
  6. **Spend:** $ and tokens by role/model and by worker, cache-hit ratio, and $ per accepted commit.
  7. **Needs your decision:** questions the agent couldn't settle (ambiguous spec items, parked tasks).
  8. **How to review and merge:** the exact `git` commands, and the suggested next goal.
- A short ntfy push points to it (no code, per §3.12). The report is generated deterministically from state and events, with at most one cheap-model call for the summary paragraph.

### 14.5 Budget defaults for one ~24 h run

`max_usd = 50`, `max_usd_per_day = 50`, `max_hours = 24`, `max_cycles = 300`, `max_turns_per_cycle = 40`, `max_tokens_per_cycle = 400k`, `warn_at = 0.8`, and **`wrapup_reserve = 0.08`**. In the last 8% of the budget or time, no new tasks start. The run finishes the current cycle, runs the full gates on `lastGreen`, writes the report and stops cleanly. Jimmy can override any of these per run (`--budget`, `--hours`). Worker backends (§15) don't count against `max_usd` (they use their own quotas), but their time counts against `max_hours`.

### 14.6 Demoted or dropped (personal use)

Dropped or postponed: multi-user concerns, marketing, public comparison claims on the site, the full changesets/Version-Packages release pipeline (see §5.6), and the post-publish smoke matrix. Kept but simple: the npm package and the one-page landing page (§6). Kept as-is: the safety layer, the tests, CI on PRs, and the M4 benchmark (now for Jimmy's own decisions, §4.7).

---

## 15. Worker backends (new, M3)

**Idea:** Omnexx stays the **single agent in charge**: it owns the plan, the judge, git, budgets and memory. For tightly scoped subtasks it can **delegate** to Jimmy's other installed coding harnesses through their headless modes, using their own quotas (often free tiers or subscriptions Jimmy already has). A worker's output is **only a candidate diff**. It goes through exactly the same VERIFY → JUDGE path as a native cycle (gates, ratchet, anti-cheat, protected paths), and is then either committed or rolled back.

### 15.1 Interface

Each worker is a plugin implementing `WorkerBackend` (`src/workers/`):

| Member | Purpose |
|---|---|
| `id`, `displayName` | e.g. `aider`, `opencode`, `claude-code` |
| `detect()` | Is it installed (resolve the binary on `PATH` or a configured path), which version (`--version`), and which capability flags this version supports (e.g. by checking `--help` output). Cached per run. |
| `buildInvocation(task, ctx)` | Returns `{ argv, env, stdin?, cwd }`. `cwd` is always an **isolated git worktree** created by the harness from `lastGreen`. The prompt is written to a file in the run state dir when the tool supports a file input. |
| `timeoutMs` | Per-worker wall-clock limit. The harness kills the **whole process tree** on timeout (SIGTERM, then SIGKILL after a grace period). |
| `quota` | Policy plus live tracking: max runs per hour and day, cooldown after a rate limit, and patterns (exit codes or output regexes) that mean "quota exhausted", "rate limited" or "auth required". State persists in `~/.omnexx/workers/state.json`. |
| `parseResult(exitCode, stdoutPath, stderrPath)` | Maps output to `{ status: completed / failed / timeout / quota_exhausted / rate_limited / auth_required, summary?, usage? }`. Full stdout and stderr are **captured to `logs/worker-<id>-<cycle>.log`** after redaction. |

The harness, not the plugin, owns: creating and removing the worktree, spawning with `execa` and the timeout, output capture, computing the candidate diff (`git diff lastGreen` including untracked files, after flattening any commits the worker made), the ref-tamper check, and the judge.

### 15.2 Uses

1. **Routing cheap subtasks:** leaf tasks with `size = S` and `kind` in a worker's `route` list (default: `tests`, `lint`, `small-refactor`, `docs`) and a clear acceptance check can go to an enabled worker instead of the native loop.
2. **"Second opinion" stuck rung:** after rung 1 (retry with evidence) fails, a **different** worker (or the native loop, if a worker failed) gets the same task with the failure evidence. That's cheaper than escalating to the strong model. It's inserted as rung 1b in §3.10.
3. **Quota rotation:** when a worker reports `quota_exhausted` or `rate_limited`, it goes into cooldown and the next eligible worker in priority order is used. If none is eligible, the native loop takes the task.
4. **Nimble-assisted choice (optional):** when the judge is on (§13), a `choice` question over the eligible workers (given the task summary plus each worker's recent acceptance rate for that task `kind`) can suggest which worker to use. Rules still decide.

### 15.3 Config

```toml
[workers]
max_concurrent = 1            # cap on simultaneously running workers
priority = ["aider", "opencode", "cline", "pi", "hermes", "openhands", "claude-code"]

[workers.aider]
enabled = false               # every worker is OFF by default (opt-in, see §15.7)
path = "aider"                # optional explicit binary path
timeout = "20m"
route = ["tests", "lint", "small-refactor"]
max_runs_per_day = 40
extra_args = []               # appended verbatim (e.g. a model choice)
# ... one table per worker
```

### 15.4 Safety

- **The worker's own auto-approve means Omnexx's command policy does not apply inside it.** Containment comes from the isolated worktree, a scrubbed environment (no `ANTHROPIC_API_KEY` or other supervisor secrets; `HOME` is kept so the tool finds its own config), **push disabled** through per-process git config overrides (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` setting a dead `pushurl`), and a **ref-tamper check** (snapshot `git for-each-ref` before and after; any change outside the worker's own worktree branch rejects the result and disables that worker for the run). `sandbox = "docker"` (M3) is recommended for unattended worker use.
- Worker output is treated like any other untrusted tool output: redacted, trimmed, never executed.
- The worker worktree is deleted after its diff is extracted. Rejected diffs are saved as `rejected/<cycle>-<worker>.patch` like native ones.

### 15.5 Concurrency

`max_concurrent = 1` by default. If it's raised, each running worker gets its own worktree, and candidate diffs are **judged one at a time** against the current `lastGreen`. A candidate that no longer applies cleanly is rejected (and may be retried once on the new base). Omnexx remains the only committer.

### 15.6 Verified headless invocations (checked Oct 3, 2026 against official docs and the versions installed on Jimmy's Mac)

| Worker | Installed on the Mac | Headless invocation (cwd = isolated worktree) | Notes |
|---|---|---|---|
| **Claude Code** | 2.1.288 (`/opt/homebrew/bin/claude`) | `claude -p "<task>" --output-format json --permission-mode auto --permission-prompts none --no-session-persistence` | `--output-format json` includes `total_cost_usd`. Uses Jimmy's own Claude Code login unless `--bare` with `ANTHROPIC_API_KEY` (bare never reads OAuth/keychain). SIGTERM exits 143. Source: code.claude.com/docs/en/headless |
| **Cline** | 3.0.62 (`/opt/homebrew/bin/cline`) | `cline --json --cwd <wt> --timeout <sec> "<task>"` | `--json` forces headless and NDJSON output. Tool auto-approve defaults to `true` (`--auto-approve true` to be explicit). The docs also describe `-y/--yolo`, but the installed 3.0.62 help doesn't list it, so detect it from `--help`. Sources: docs.cline.bot/usage/cli-overview, docs.cline.bot/cli/cli-reference |
| **OpenHands** | CLI 1.16.0, SDK 1.21.0 (`~/.local/bin/openhands`) | `openhands --headless --json -f <task-file>` (or `-t "<task>"`) | Headless always auto-approves and requires `--task`/`--file`. `--json` streams JSONL events. `OPENHANDS_SUPPRESS_BANNER=1`. `--override-with-envs` reads `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL`. Source: docs.openhands.dev/openhands/usage/cli/headless |
| **OpenCode** | 1.18.30 (`/opt/homebrew/bin/opencode`) | `opencode run --dir <wt> --auto --format json "<task>"` | `--auto` auto-approves permissions that aren't explicitly denied. `-m provider/model` is optional. `OPENCODE_DISABLE_AUTOUPDATE=1`. Source: opencode.ai/docs/cli |
| **Aider** | 0.86.2 (`/opt/homebrew/bin/aider`) | `aider --message-file <task-file> --yes-always --no-auto-commits [files…]` | `--message`/`-m` or `--message-file`/`-f` processes one instruction and exits. The installed version uses `--yes-always` (the scripting docs page still shows the older `--yes`). Optional `--test-cmd`, `--auto-test`, `--lint-cmd`, `--auto-lint`. Avoid `--analytics-disable` in the adapter, since it changes Aider's config permanently. Source: aider.chat/docs/scripting.html, plus `aider --help` |
| **Hermes Agent** | 0.16.0 (`~/.local/bin/hermes`) | `hermes -z "<task>"` | One-shot: prints only the final response, and approvals are auto-bypassed. Documented exit codes: 0 completed, 2 failed or partial, 130 interrupted, 1 no text (judge the run by its exit code; Omnexx judges by the gates anyway). Alternative: `hermes chat -Q -q "<task>" --max-turns N`. Newer releases need `--oneshot` or `-Q` for `-q` to exit. Source: hermes-agent.nousresearch.com/docs/reference/cli-commands |
| **Pi** | 0.84.2 (`/opt/homebrew/bin/pi`) | `pi -p --no-session "<task>"` (or `pi --mode json "<task>"` for JSONL events) | Non-interactive modes ignore untrusted project-local resources by default (`-na` forces that). The default provider is `google`, and `--provider`/`--model` are optional. Source: github.com/badlogic/pi-mono, packages/coding-agent/docs/usage.md |
| *(also installed)* Codex CLI | 0.132.0 | `codex exec -C <wt> -s workspace-write --json --ephemeral -o <last-msg-file> "<task>"` | Not on Jimmy's list. A candidate extra worker. |

Adapters must re-verify flags at runtime (`detect()` parses `--help`/`--version`), because these CLIs change fast.

### 15.7 Terms-of-service and credential caveat

**Automating consumer free tiers or subscriptions can violate those services' terms and put the account at risk.** So every worker is **opt-in individually** and **off by default**. `omnexx doctor` and the first enable of each worker print a one-line warning, and `docs/workers.md` repeats it. Omnexx **never reads, copies, stores or logs any worker's credentials**: they stay in each tool's own config. The worker environment is scrubbed, and worker logs go through the redaction filter. Quota caps (`max_runs_per_day`) default conservatively.

### 15.8 Milestones

- **M0–M2:** the `WorkerBackend` interface and types, the config schema (`[workers]`, all off), and a **working fake worker** (a small script in test fixtures that applies a scripted patch, can simulate timeout, quota exhaustion and ref tampering, and writes output). That's enough to test the harness-side lifecycle: worktree, timeout kill, capture, candidate diff, judge, commit or rollback. **No real adapters.**
- **M3:** real adapters for Aider, OpenCode, Cline, Pi, Hermes, OpenHands and Claude Code (the priority order is Jimmy's call), quota tracking and rotation, routing, the second-opinion rung, Nimble-assisted choice, and contract tests against recorded CLI outputs. Real-tool smoke tests run only locally with `OMNEXX_WORKER_E2E=1`, never in CI.
- **M4:** workers off versus on arms in the benchmark.

---

*End of plan. Prepared Oct 3, 2026 (CT); §13–§15 and the personal-use revision added the same day. Planning only: no code, deploys or repo changes were made.*
