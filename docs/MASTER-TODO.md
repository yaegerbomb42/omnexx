# Master TODO: beat Cline and Claude Code (2026-10-16)

Twenty changes, each grounded in a measurement from this repo's own bench runs or code. Ordered
by expected impact. Items 1–5 are the day's work; each later item is independent and sized for a
single PR into `main`.

## What the numbers say

Source: `bench/results/base-1014-r1/calls.jsonl` (362 metered calls, same model for every
harness) and `bench/results/confirm-task-03-*/work/**/events.jsonl`.

| Measured                                                                       | omnexx                                       | Cline                           |
| ------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------- |
| Worker API calls, jimmy10 tasks 1–5                                            | 262 (8 conversations, 12–60 turns each)      | 44 for tasks 1–4 (~11 per task) |
| Tool calls per assistant turn (task-03, 3 runs)                                | 1.33–1.73; 3–12 multi-call turns of 13–29    | n/a                             |
| Bookkeeping calls (`todo`, `running_context`, `remember`, `context`, `recall`) | 9/45, 6/22, 4/16 of all tool calls (20–30 %) | 0                               |
| `list` calls despite "use search, not list"                                    | 6 in one 45-call run                         | –                               |
| Output per turn                                                                | 140–318 tokens; 10–20 % of turns < 60        | –                               |
| Prefix cache hit: worker / reviewer / audit / codemap                          | 93 % / 20 % / 10 % / 0 %                     | 87 %                            |
| Idle gaps > 60 s across 5 tasks                                                | 9 gaps, 7,158 s idle, longest 4,084 s        | none                            |
| Wall: task-02 / task-03                                                        | 351 s / 2,714 s                              | 76 s / 90 s                     |
| Fresh tokens: task-02 / task-03                                                | 69.6k / 187k                                 | 20.6k / 11.8k                   |
| First call of a conversation (tiny repo)                                       | 5,042 prompt tokens                          | –                               |

The pass rate is already level (9/10 vs 9/10). The gap is **turns**: every extra turn is a
round-trip, a fresh-token delta and a chance to drift. Everything below either removes turns,
removes idle time, or protects the pass rate.

---

## Today (1–5)

### 1. Make multi-call turns the norm

- **Why:** task-03 averaged 1.33–1.73 tool calls per turn (3–12 multi-call turns per run) even
  though the prompt says "Batch". Cline does a task in ~11 calls; omnexx takes 13–60 turns.
- **Change:**
  - `read` accepts `paths: [{path, start?, end?}]` (one call, N files; results concatenated with
    headers). `search` accepts `queries: []`. `outline` accepts `paths: []`.
  - In `src/agent/loop.ts`, when an assistant turn issued exactly one `read`/`search`/`outline`
    while the session is still in exploration (no edit yet), append one line to that tool result:
    "You can send several read/search/outline calls in one turn." Emit once per session, not per
    turn.
  - Count calls-per-turn into the `turn` event and `omnexx status --json`.
- **Files:** `src/tools/read.ts`, `search.ts`, `outline.ts`, `src/agent/loop.ts`,
  `src/agent/prompts.ts`.
- **Verify:** bench task-03 three times; target ≥ 2.0 calls/turn in exploration, turns −30 %.

### 2. Take bookkeeping out of the turn loop

- **Why:** a fifth to a third of all tool calls are `todo`, `running_context`, `remember`,
  `context`, `recall`. Each is a full round-trip that produces no code.
- **Change:**
  - Derive the first todo list from the think phase's analysis (it already lists steps): parse
    it, emit `todo.update`, no tool call.
  - `running_context` becomes a side channel: accept an optional `note` field on every tool call
    schema (`{..., note?: string}`); the loop records it without a turn. Keep the tool only for
    long sessions (> 25 turns) and say so in the description.
  - Drop the "Start with a todo list" and "Keep your running context current" instructions for
    tasks the planner marked small (≤ 2 files); keep them for long tasks.
- **Files:** `src/core/think-loop.ts`, `src/tools/todo.ts`, `src/tools/running-context.ts`,
  `src/agent/loop.ts`, `src/agent/prompts.ts`.
- **Verify:** bookkeeping share < 8 % of tool calls on jimmy10; todo still shows live in TUI /
  VS Code.

### 3. Gates: related tests on inner passes, full suite once

- **Why:** `checkTree` runs every configured gate on every think-loop pass, and
  `loop_flaky_reruns` defaults to 2, so a red gate runs **three times per pass**. task-03 took
  2,714 s wall at 187k fresh tokens; Cline 90 s.
- **Change:**
  - Detect vitest / jest / pytest / go test gates. Inner passes run only tests related to the
    files changed since the last green tree (`vitest related <files>`, `jest
--findRelatedTests`, `pytest <touched test files>`, `go test ./<pkgs>`); unknown runners keep
    the full command.
  - Flaky reruns only on the final confirming pass, and only for the failed ids.
  - The last pass before "green" always runs the full command.
- **Files:** `src/core/think-loop-check.ts`, `src/verify/gates.ts`, `src/verify/flaky.ts`, new
  `src/verify/related-tests.ts`.
- **Verify:** task-02 and task-03 wall under 4 min; the integration test proves the full suite
  still runs before a session is called green.

### 4. Stop a run that has gone quiet, and fail a hung bench setup

- **Why:** the 7,158 s is not time between turns. The bench ran one job at a time, and two jobs
  held the clock while doing no model work (`bench/results/base-1014-r1/2026-10-14.jsonl`):
  - task-04 omnexx: 40.4 min wall, 6 requests, 381 output tokens, `interventions: 1`. That flag
    means the bench killed it. `--hours` defaults to 0.5 and the runner's own timeout is that
    plus 10 min (`bench/runners/omnexx.ts`), so the run never stopped itself and sat until the
    outer kill.
  - task-03 omnexx: last model call ~29 min before the job ended, same outer kill (`interventions:
1`, 45 min wall).
  - OpenHands task-03: `git init … exited null`, `wall_ms: 0`, but the job occupied 34 min
    (20:11–20:45) before the next job could start. `runBash` (`bench/suites/dir-suite.ts`) arms a
    5 min kill and then waits on `exit`, so a child that survives the signal holds the bench.
- **Change:**
  - The supervisor enforces `--hours` itself: at the deadline it stops the run, records
    `run.stopped {reason: 'hours'}`, and exits. The bench timeout stays a backstop (the 10 min
    margin), not the thing that ends a quiet run.
  - A run with no model call, tool result, or gate progress for 3 min stops with
    `run.stopped {reason: 'idle', lastEvent}`. A gate or command that is still inside its own
    timeout does not count as idle. `omnexx status` shows the reason.
  - `runBash` settles when its timer fires (kill the process group, then resolve; do not wait
    on `exit`). A setup or hidden check that hangs fails in 5 min and the pool moves on.
- **Files:** `src/core/supervisor.ts`, `bench/runners/omnexx.ts`, `bench/runners/base.ts`,
  `bench/suites/dir-suite.ts`.
- **Verify:** a scripted run that stops calling the model is recorded `idle` within 3 min and
  the process has exited. A `runBash` whose child ignores the signal returns in 5 min. A rerun
  of jimmy10 tasks 03 and 04 shows no job whose wall time is the outer timeout.
- **Status (2026-10-16), revised by evidence:** the 180 saved run logs under `bench/results/`
  show what the silence was. Every uncovered gap over 2 min was a model request that hung
  until a timeout: ~900 s ("operation was aborted due to timeout", the 10 min
  `request_timeout` plus retries) or 300–500 s (the bench meter's upstream `fetch` hitting
  Node's 300 s header timeout), then retry windows of ~1,000 s. Unattended worker calls didn't
  stream, so nothing could tell a hung call from a slow one. A generic "3 min idle → stop"
  would have killed legitimate long gates and still waited on the hung call, so it was not
  built. What was built:
  - `stall_timeout` per endpoint (default 3 min remote, off for localhost; the bench sets it
    for its 127.0.0.1 meter). Requests stream, and one that sends no bytes for that long,
    before headers or between chunks, is cut as a retryable error. A server that refuses
    streams, answers with JSON, or omits usage in a stream is asked plainly from then on.
  - max_hours enforced inside a cycle: the watchdog ends the cycle at the deadline, its partial
    work is verified as usual (not counted as hung), and the run stops at the boundary.
  - The bench meter cancels the upstream call when its client gives up.
  - `runBash` settles at its timeout whether or not the child exits.

### 5. Bench efficiency columns and a correct summary row

- **Why:** the results table has no turns, calls/turn, idle, gate seconds or fresh-per-turn, so
  items 1–4 cannot be measured. The summary row prints "cline 12/13" for the whole table.
- **Change:** `bench/results.ts` reads each run's `events.jsonl` and writes
  `efficiency.json` + columns: Turns, Calls/turn, Bookkeeping %, Gate s, Idle s, Fresh/turn,
  Cache %. One summary row per agent. `--quick` becomes a nightly workflow that posts the table.
- **Files:** `bench/results.ts`, `bench/run.ts`, `.github/workflows/bench-nightly.yml`.
- **Verify:** `test/unit/bench/results.test.ts` covers the new columns and per-agent summary.
- **Status (2026-10-16):** done except the nightly workflow. Efficiency lives in each result's
  `metrics.efficiency` in the JSONL (no separate file); the think-loop now emits `loop.gates`
  with gate time and rerun count. The nightly job needs a model endpoint secret and the owner's
  go-ahead to spend on it, so it is left out.

---

## Tokens and caching (6–10)

### 6. Reviewer and audit ride the worker's cached prefix

- **Why:** reviewer 20 % cached, audit 10 %, versus 93 % for the worker. They use their own
  system prompts, so every review re-pays the whole prefix.
- **Change:** the end-of-session review and the audit are sent as a user turn appended to the
  worker conversation (same system + codemap prefix, already cached), with the review rubric in
  the user message. Keep the separate-prompt path only when the conversation exceeds the budget.
- **Files:** `src/verify/review.ts`, `src/core/think-loop.ts`, `src/core/audit*.ts`.
- **Verify:** `calls.jsonl` shows review calls at ≥ 80 % cached on jimmy10.

### 7. Cache-miss detector and `prompt_cache_key`

- **Why:** a single non-deterministic byte in the prefix (timestamp, unsorted list, new lesson
  mid-cycle) silently turns every later turn into a full re-read. Nothing reports it.
- **Change:** after each turn compare `cached_tokens` with the previous call's prompt size;
  below 80 % emit `cache.miss {expected, got, turn}` and show it in `status`. Send OpenAI's
  `prompt_cache_key` (per run id) on `openai-compat` for providers that accept it. Add a property
  test that renders the prefix twice in one cycle and asserts byte equality.
- **Files:** `src/agent/loop.ts`, `src/providers/openai-compat.ts`, `src/agent/context.ts`.
- **Verify:** unit test with a scripted provider; bench cache % never dips mid-conversation.

### 8. First-call budget: 5k → 3.5k tokens

- **Why:** the first call of every conversation is 5,042 tokens on a 10-file repo. Most of it is
  17 tool schemas plus a long worker prompt; it is paid once per conversation (8 per 5 tasks) and
  on every cache miss.
- **Change:** `cycle.context` reports token split per block (system, tools, codemap, lessons,
  state). Shorten tool descriptions (move "how to work" text into the system prompt once), drop
  `list` and `recall` from the default worker set (see 9, 12), and cap lessons at 1k for the fast
  path.
- **Files:** `src/agent/context.ts`, `src/tools/*.ts` descriptions, `src/agent/prompts.ts`.
- **Verify:** a unit test asserts the fresh-repo first call ≤ 3.5k estimated tokens.

### 9. Retire `list`

- **Why:** 6 `list` calls in one run even though the prompt says not to; the codemap already has
  the tree.
- **Change:** `outline` gains a directory mode that returns the codemap slice for that path (files
  - top symbols). `list` is removed from the worker set; its description in chat says "prefer
    outline".
- **Files:** `src/tools/list.ts`, `src/tools/outline.ts`, `src/tools/registry.ts`.
- **Verify:** zero `list` calls on jimmy10; tool tests updated.

### 10. Test-output digests for `bash`

- **Why:** the largest tool results in test tasks are test runner logs (stack traces, repeated
  frames). `bash` cuts at 12k chars head/tail; the model still pays for noise and sometimes
  loses the one assertion that mattered.
- **Change:** when the command looks like a test runner (vitest/jest/pytest/go test/cargo test),
  parse the output into failing test names, assertion message and the first in-repo frame; return
  that (≤ 1.5k chars) with `read_log id` for the rest. Reuse `src/verify/triage.ts` classifiers.
- **Files:** `src/tools/bash.ts`, new `src/tools/test-digest.ts`, `src/verify/triage.ts`.
- **Verify:** fixtures for each runner; task-02 fresh tokens −20 %.

---

## Pass rate and recovery (11–15)

### 11. Right-size the think phase

- **Why:** `loop_think_turns` is 8 with thinking on for every task; r1 of task-03 shows 14
  thinking events. Small tasks (task-01/04/05 finish in 12–20 turns) pay a full think round.
- **Change:** size the think budget from the goal: ≤ 60 words and ≤ 2 codemap hits → 3 think
  turns and skip the DECIDE round; otherwise today's defaults. Record the choice in `phase`.
- **Files:** `src/core/think-loop.ts`, `src/core/think-loop-run.ts`,
  `src/config/sections/plan.ts`.
- **Verify:** task-01/04/05 turns −25 % with no pass-rate change over 3 runs.

### 12. Conditional native tools

- **Why:** lazy MCP mounting landed (#187); native tools are still all-on. `task`, `recall`,
  `context`, `read_log` and the browser tools cost schema tokens on every call and invite
  needless turns.
- **Change:** expose `task` only when `[context] subagents = true`; `read_log` only after a cut
  output exists; `recall` only when the lessons file is non-empty; browser tools only when a
  browser gate or a web task is detected. The system prompt lists only exposed tools.
- **Files:** `src/tools/registry.ts`, `src/agent/context.ts`.
- **Verify:** schema tokens on a fresh repo −35 %; existing tool tests pass with explicit opt-in.

### 13. Self-correcting denials and shell errors

- **Why:** task-03 runs show `tool.denied` and failed `bash` calls that each cost a turn with no
  guidance.
- **Change:** every policy denial names the allowed alternative ("`git commit` is denied: omnexx
  commits for you after checks pass"). `command not found` / `no such file` in bash output get a
  did-you-mean from `facts.json` and package scripts ("tests run with `npm test`"). Extend
  `src/tools/did-you-mean.ts`.
- **Files:** `src/security/command-policy.ts`, `src/tools/bash.ts`, `src/tools/did-you-mean.ts`.
- **Verify:** unit tests for the top 10 denials and errors; zero repeated denials in bench events.

### 14. Pre-probed repo facts in the first state block

- **Why:** r2 of task-03 made 8 `bash` calls, several to discover how to run things. `facts.json`
  is recorded from runs, so a fresh repo has none.
- **Change:** at session start run a deterministic probe (package manager and scripts, test
  runner, lint, build, language toolchain, monorepo layout) and inject "Run tests: …" style facts
  into the state block. Record them as verified facts with the probe hash.
- **Files:** `src/core/facts.ts`, new `src/core/repo-probe.ts`, `src/agent/context.ts`.
- **Verify:** first-turn `bash` discovery calls → 0 on jimmy10; facts survive hash invalidation.

### 15. One-turn edit recovery for `str_replace`

- **Why:** a missed `old_text` costs a read plus a retry (2 turns). `replace_lines` has anchors;
  `str_replace` does not.
- **Change:** on a miss, return the closest region (normalised whitespace, best token overlap)
  with anchored line tags so the next turn can `replace_lines` directly. Count misses in the
  `tool` event.
- **Files:** `src/tools/edit.ts`, `src/tools/did-you-mean.ts`, `src/tools/post-edit.ts`.
- **Verify:** fixture misses resolve in one follow-up turn; miss rate visible in `status`.

---

## Reliability (16–18)

### 16. Provider-conformance harness in CI

- **Why:** the last four fixes (#171, #175, #181, #185) were provider quirks found by hand:
  429 idling, null tool-call content, `max_completion_tokens`. The next one will be found the
  same way unless a test matrix exists.
- **Change:** a mock OpenAI-compatible server with pluggable quirks (reasoning-model params,
  `content: null`, 429 with `retry-after`, split streaming chunks, empty `choices`, 400 on
  unknown fields, tool-call id reuse). Each past bug becomes a fixture; every provider adapter
  runs the matrix.
- **Files:** `test/fixtures/providers/quirk-server.ts`, `test/integration/providers/*.test.ts`.
- **Verify:** matrix green; adding a quirk reproduces its original bug on the pre-fix commit.

### 17. Calibrated token estimates

- **Why:** folds and budget pre-flight use a fixed 3 chars/token estimate. Too low → context
  overflow 400s; too high → early folds that lose working state.
- **Change:** per model, keep an EMA of `usage.prompt_tokens / estimate` from each turn
  (persisted next to `latency.json`); `estimateTokens` applies it. Start at 1.0 for unknown
  models.
- **Files:** `src/core/tokens.ts`, `src/agent/loop.ts`, `src/core/run-history.ts`.
- **Verify:** property test that the ratio converges on a scripted provider; `cost-sim.test.ts`
  fold counts unchanged within 5 %.

### 18. Chat-server flow tests

- **Why:** the live errors came from the chat surface (Settings model pick, stop/pause, chat
  outside a repo, Compact). Those paths have thin coverage compared to the run loop.
- **Change:** an integration test drives `omnexx chat-server` with a scripted provider through
  the eight flows the owner tests by hand: pick model, send, stop, pause/resume, steer mid-turn,
  compact, new chat keeps history, MCP toggle.
- **Files:** `test/integration/chat-server-flows.test.ts`, `src/cli/chat-server.ts`.
- **Verify:** in `test:quick`; each flow asserts the events the VS Code panel relies on.

---

## Observability for live testing (19–20)

### 19. `omnexx doctor --run <id>`

- **Why:** live testing produces runs, not diagnoses. The owner should be able to paste one
  command's output and have the inefficiency named.
- **Change:** reads a finished run's `events.jsonl` and prints the top five: single-call
  exploration turns, repeated reads of unchanged ranges, bookkeeping share, gate time share,
  idle time, cache dips, denied commands, edit misses; each with turn numbers and the fix hint.
  Same code feeds item 5's columns.
- **Files:** `src/cli/commands/doctor.ts`, new `src/telemetry/efficiency.ts`.
- **Verify:** unit test on the three task-03 event files reproduces the numbers in the table
  above.

### 20. Turn-level trace in the TUI and VS Code

- **Why:** when a run feels slow nobody can see why without reading `events.jsonl`.
- **Change:** a compact per-turn line in the TUI run view and the VS Code run panel: turn #,
  tool calls in the turn, fresh/cached tokens, latency, gate status, and a warning glyph when
  item 19's rules fire. Toggle with `/trace`.
- **Files:** `src/tui/session.ts`, `vscode/src/webview/*`, `src/telemetry/humanize.ts`.
- **Verify:** snapshot test of the rendered line; no change to the default view.

---

## Order of operations

1. Land 5 first (measurement), then 1–4; rerun `npm run bench -- --suite jimmy10 --agents
omnexx,cline --endpoint DEEPSEEK` three times per task and record the table in
   `bench/results/`.
2. Then 6–10 (tokens), 11–15 (pass rate), 16–18 (reliability), 19–20 (live testing).
3. Each item is one PR into `main`, CI green, squash-merged, branch deleted. Append a session
   entry to `docs/TODO.md` when a group lands and tick the item here.
