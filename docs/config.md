# Configuration

Precedence, highest first: **CLI flags > `OMNEXX_*` env > `./omnexx.toml` (project) > `~/.config/omnexx/config.toml` (user) > defaults.** Tables merge key by key; arrays replace. Unknown keys are errors. A bad value fails with one line naming the file and key.

Durations are strings: `"30s"`, `"5m"`, `"2h"`, `"1h30m"`.

## Top level

| Key         | Default                                                                                                                                                                                      | Meaning                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `setup`     | `[]`                                                                                                                                                                                         | Commands run once in the run's worktree before planning (e.g. `["npm ci"]`).                    |
| `sandbox`   | `"host"`                                                                                                                                                                                     | `"host"` only. `"docker"` fails with "not implemented (M3)".                                    |
| `protected` | `omnexx.toml`, `.github/**`, `.gitlab-ci.yml`, `.circleci/**`, lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock[b]`, `poetry.lock`, `Cargo.lock`, `go.sum`), `.env*` | Globs the agent may not change (anti-cheat). A task can lift this with `allow = ["protected"]`. |

## `[docker]` (when `sandbox = "docker"`)

| Key          | Default              | Meaning                                                                             |
| ------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `image`      | `"node:22-bookworm"` | Must contain your toolchain (node, python, go…)                                     |
| `network`    | `"bridge"`           | `"none"` cuts the network off (setup like `npm ci` then needs to happen beforehand) |
| `cpus`       | `"2"`                |                                                                                     |
| `memory`     | `"4g"`               |                                                                                     |
| `pids_limit` | `1024`               |                                                                                     |
| `tmp_size`   | `"2g"`               | Size of the in-container `/tmp` tmpfs (HOME lives there)                            |

The container runs as your uid/gid with `--cap-drop ALL`, `no-new-privileges`, a read-only root, and only the worktree and the run's scratch dir mounted read-write (plus the repo's `.git` read-only). Worker backends still run on the host.

## `[[gates]]`

| Key               | Default                      | Meaning                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | required                     | Letters, digits, `_ . -`                                                                                                                                                                                                                                         |
| `run`             | required                     | Shell command, run in the worktree with a scrubbed env                                                                                                                                                                                                           |
| `timeout`         | `"10m"`                      | Capped by `budget.max_cmd_timeout`                                                                                                                                                                                                                               |
| `level`           | `"ratchet"`                  | `"must-pass"`: exit 0. `"ratchet"`: no new failure ids and no more failures than the baseline                                                                                                                                                                    |
| `parser`          | `"generic"`                  | `vitest` (`--reporter=json --outputFile=/dev/stdout`), `jest` (`--json`), `node-test` (`--test-reporter=tap`), `tsc`, `eslint` (`-f json` or default output), `pytest` (`-rf`), `gotest` (`-json`), `cargo` (default `cargo test` output), `generic` (exit code) |
| `flaky_reruns`    | `1`                          | `0`–`3`. When the gate shows new failures the parser can name, run the whole gate again; ids that then pass are flaky (event `verify.flaky`, a `flaky` lesson, a line in the report) and don't fail the cycle. Timeouts and `generic` gates are never re-run     |
| `kind`            | `"openai"`                   | `openai` (Chat Completions), `responses`, `gemini` or `anthropic` (Anthropic-compatible Messages API)                                                                                                                                                            |
| `url`             | `"http://localhost:${PORT}"` | Browser gates: the page to check                                                                                                                                                                                                                                 |
| `script`          | –                            | Browser gates: a YAML/TOML steps file. Without one: open, wait, the page must render content and log no console errors or uncaught exceptions                                                                                                                    |
| `requires_script` | –                            | Pass without running while `package.json` has no script of this name. The empty-folder starter uses `"start"` so non-web projects never pay                                                                                                                      |

## `[budget]` (24 h defaults, plan §14.5)

| Key                    | Default  | Meaning                                                                                                                                                                                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_usd`              | `50`     | Run total. The pre-flight check before every call keeps spend under it. Hitting it → `budget-stop` (exit 3), resumable after raising it.                                                                                                    |
| `max_usd_per_day`      | `50`     | Rolling 24 h cap. Each call is pre-flighted against it; at 90%, or when a call is refused, the run pauses (status `paused`, ntfy `budget`) until half the cap is free, then resumes on its own. The wait does not count toward `max_hours`. |
| `max_hours`            | `24`     | Active wall-clock across restarts.                                                                                                                                                                                                          |
| `max_cycles`           | `300`    |                                                                                                                                                                                                                                             |
| `max_turns_per_cycle`  | `40`     |                                                                                                                                                                                                                                             |
| `max_tokens_per_cycle` | `400000` | Input + output of every call in a cycle, before cache discounts.                                                                                                                                                                            |
| `task_max_tokens`      | unset    | Per-task input + output. The pre-flight check parks the task (checkpoint to `checkpoints/task-*.json`, `budget-stop`) before it can cross 100%; warns once at `warn_at`.                                                                    |
| `task_max_usd`         | unset    | Per-task dollars, same parking path. Kept separate from `max_usd` so one runaway task cannot drain a healthy run's budget.                                                                                                                  |
| `max_cmd_timeout`      | `"30m"`  | Upper bound for every gate, check and `bash` call.                                                                                                                                                                                          |
| `warn_at`              | `0.8`    | ntfy `budget` warning at this fraction of the tightest of USD / hours / cycles.                                                                                                                                                             |
| `wrapup_reserve`       | `0.08`   | In the last 8%: no new task, verify `lastGreen`, report, stop. `0` disables.                                                                                                                                                                |

## `[models]` and `[pricing.<alias>]`

| Key       | Default                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `planner` | `"anthropic:opus"` → `claude-opus-5-5`                                                                                      |
| `worker`  | `"anthropic:sonnet"` → `claude-sonnet-5-5`                                                                                  |
| `cheap`   | `"anthropic:haiku"` → `claude-haiku-4-5-20251001` (codemap purposes, notes consolidation, `llm` judge)                      |
| `chat`    | unset → the `worker` chain. The model chat mode talks to, e.g. `"pool:kimi-k2.7-code"`; `/model` overrides it for a session |

Prices live in `src/providers/pricing.ts` (USD per MTok, checked 2026-10-03). Override or add one:

```toml
[pricing.sonnet]
id = "claude-sonnet-5-5"
input = 2
output = 10
cache_write_5m = 2.5
cache_write_1h = 4
cache_read = 0.2
```

Only the `anthropic:` provider exists in this build. Model routing per turn is M3; the worker model does all cycle work.

## Model chains and endpoints

Each role takes one model or a failover chain:

```toml
[models]
planner = "anthropic:opus"
worker  = ["anthropic:sonnet", "openrouter:or-sonnet", "ollama:qwen3:32b"]
cheap   = ["anthropic:haiku", "ollama:qwen3:8b"]

[providers.endpoints.openrouter]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"   # the name of the env var, never the key
max_usd = 20                         # optional cap for this provider
max_usd_per_day = 5                  # optional

[providers.endpoints.ollama]
base_url = "http://localhost:11434/v1"
free = true                          # $0 for any model unless [pricing] says otherwise

[pricing.or-sonnet]
id = "anthropic/claude-sonnet-5.5"
input = 2
output = 10
cache_write_5m = 2.5
cache_write_1h = 4
cache_read = 0.2
```

| `[providers.endpoints.<name>]` key | Default    | Meaning                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                             | `"openai"` | Chat Completions API                                                                                                                                                                                                                                                                                                |
| `base_url`                         | required   | e.g. `https://api.openai.com/v1`                                                                                                                                                                                                                                                                                    |
| `api_key_env`                      | unset      | Env var holding the key; unset for local endpoints                                                                                                                                                                                                                                                                  |
| `auth`                             | `"bearer"` | How the key is sent: `bearer`, `api-key` (an `api-key` header, Azure) or `none`                                                                                                                                                                                                                                     |
| `headers`                          | unset      | Extra request headers, e.g. `{ "X-Org" = "team" }` (plain text: never put a secret here)                                                                                                                                                                                                                            |
| `free`                             | `false`    | Price unknown models at $0                                                                                                                                                                                                                                                                                          |
| `request_timeout`                  | `"10m"`    |                                                                                                                                                                                                                                                                                                                     |
| `stall_timeout`                    | see note   | A request that sends nothing (no headers, no next chunk) for this long is cut and retried, so a hung call costs minutes, not `request_timeout`. Requests stream so stalls show. Unset: `"3m"` for remote endpoints, off for localhost (a slow machine can take minutes to read a long prompt). `"off"` turns it off |
| `sticky_random`                    | `false`    | For a pool whose `*-random` model picks a different model each request: omnexx picks one real chat model itself and keeps it (warm prompt cache) until it reports it is out of quota, then moves to the next. The pick and exhausted models are remembered in `sticky-<name>.json` for 24 h                         |
| `max_usd` / `max_usd_per_day`      | unset      | Per-provider caps; also accepted under `[providers.anthropic]`                                                                                                                                                                                                                                                      |

Each turn tries the chain in order. Providers over their own caps are skipped; a failing provider cools for 1 minute (transient errors) or 30 minutes (key, quota or unknown model) while the next one takes the call. If every provider is over its cap, the run stops as a budget stop; if every one is failing, the normal outage backoff applies. Events: `provider.failover`; spend per provider in `status --json` (`spend.byProvider`).

No endpoints are built in: any OpenAI-compatible server (OpenAI, OpenRouter, Groq, DeepSeek, Together, LiteLLM, vLLM, Ollama, LM Studio, your own gateway) is one `[providers.endpoints.<name>]` block in `omnexx.toml` or `~/.config/omnexx/config.toml`. The block's name becomes the model-ref prefix.

## `[providers.anthropic]`

| Key                | Default     | Meaning                                                                              |
| ------------------ | ----------- | ------------------------------------------------------------------------------------ |
| `base_url`         | API default | e.g. a proxy                                                                         |
| `cache_ttl`        | `"5m"`      | `"5m"` or `"1h"` cache writes for in-cycle message breakpoints                       |
| `prefix_cache_ttl` | `"auto"`    | Stable-prefix breakpoint: `"auto"` = `"1h"` when `budget.max_hours > 1`, else `"5m"` |
| `max_tokens`       | `16000`     | Output cap per turn; also the worst case used by the pre-flight check                |
| `request_timeout`  | `"10m"`     | Per request                                                                          |

## `[git]`

| Key       | Default        | Meaning                                                                                                                                                                                |
| --------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push`    | `"none"`       | `"branch"` pushes `omnexx/<runId>` (never force) after each checkpoint                                                                                                                 |
| `remote`  | `"origin"`     |                                                                                                                                                                                        |
| `open_pr` | `false`        | At the end of a run with commits: push the branch and open a PR with `gh` (title from the goal, the report as body); the link goes into the finish notification. Needs `gh auth login` |
| `pr_base` | current branch | The PR's base branch                                                                                                                                                                   |

## `[notify.webhook]` (optional)

| Key          | Default                                        | Meaning                                                                 |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `url_env`    | required                                       | Env var holding a Slack or Discord incoming-webhook URL (it's a secret) |
| `events`     | `finished, needs-human, budget, crash, outage` | Which events post                                                       |
| `timeout_ms` | `5000`                                         |                                                                         |

## `[notify.ntfy]` (optional)

| Key          | Default                                                 | Meaning                                                                          |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `server`     | `"https://ntfy.sh"`                                     |                                                                                  |
| `topic`      | required                                                | Public topics on ntfy.sh are guessable; use a random suffix or a protected topic |
| `token_env`  | unset                                                   | Name of an env var holding a bearer token                                        |
| `events`     | `started, finished, needs-human, budget, crash, outage` | Also `stopped`                                                                   |
| `timeout_ms` | `5000`                                                  |                                                                                  |

Pushes carry only the run id, repo name, status, a task title, counts and dollar amounts, redacted.

## `[judge]` and `[judge.nimble]` (see [judge.md](judge.md))

| Key                       | Default                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `kind`                    | `"none"` (`none`, `nimble`, `llm`)                            |
| `fallback`                | `"none"` (`none`, `llm`)                                      |
| `mode`                    | `"advise"` (`advise`, `steer`)                                |
| `steer_min_probability`   | `0.6`                                                         |
| `uses`                    | `["next_move", "drift", "failure_similarity", "tool_safety"]` |
| `nimble.url`              | `"http://localhost:11434"`                                    |
| `nimble.model`            | `"nimble"`                                                    |
| `nimble.timeout_ms`       | `3000`                                                        |
| `nimble.keep_alive`       | `"30m"`                                                       |
| `nimble.breaker_failures` | `3`                                                           |
| `nimble.breaker_reprobe`  | `"10m"`                                                       |

## `[stuck]`

| Key                          | Default | Meaning                                                                                                               |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `max_consecutive_rejections` | `3`     | Same task rejected N times in a row                                                                                   |
| `max_same_signature`         | `3`     | Same normalized failure N times for a task                                                                            |
| `max_task_cycles`            | `8`     | Cycles spent on one task without finishing it                                                                         |
| `no_progress_cycles`         | `12`    | Run-level: no accepted commit in N cycles → `needs-human`                                                             |
| `no_progress_hours`          | `3`     | Same, by time                                                                                                         |
| `oscillation_window`         | `5`     | How many earlier green commits the A→B→A check looks back                                                             |
| `repeated_tool_call`         | `3`     | In-cycle: the same tool call with identical arguments this many times ends the cycle                                  |
| `no_edit_turns`              | `15`    | In-cycle: this many turns since the last file edit (or cycle start) ends the cycle                                    |
| `burn_factor`                | `3`     | In-cycle: tokens above this × the median of recent cycles, before any edit, end the cycle (needs 3 cycles of history) |

An in-cycle signal ends the cycle as `stuck` (events `stuck.in_cycle`, then `stuck.signal`). Its partial work still goes through VERIFY, so it's committed if the gates pass and rolled back otherwise; the next attempt gets the reason as evidence, and the strategy ladder climbs one rung.

## `[agent]`: the five settings the agent manages itself by

Set them with `/settings` in the terminal (Tab moves, ←→ change, Enter saves) or the **Agent** card
in the VS Code panel; both save to `agent-settings.json` in your config folder. A project can pin
them here. Unset levels change nothing; set ones derive the keys below, above your `config.toml`
and below a project's `omnexx.toml` and CLI flags (so `--for 8h` still wins).

| Key                   | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_effort`         | unset   | 1 = quick MVP … 10 = build a monolith. Sets `[plan]` `loop_think_turns` (2…32), `loop_rounds` (2…18), `loop_rethinks` (0…5), `mode` (1-3 `fast`, 8-10 or 6+ with ≥4h `full`) and `milestones` (1 at level 1, unset from 8); the agent is told what its level means                                                                                                                                                          |
| `turn_effort`         | unset   | Thinking per model call: `reasoning_effort` minimal/low/medium/high on OpenAI-style APIs, a thinking budget (0…32k tokens) on Anthropic and Gemini                                                                                                                                                                                                                                                                          |
| `context_level`       | unset   | Context budget 5k, 10k, 20k, 40k, 64k, 96k, 128k, 200k, 500k, 1M (clamped to 85% of the worker model's window: the profile's `context`, else the documented window of known families, e.g. 1M for Claude Opus/Sonnet 5.x, Gemini 2.x/3 Pro/Flash, GPT-4.1). Sets `[context]` `budget_tokens`, `compact_at` (85% of it), `clear_tool_results_at`, turns and tool results kept, notes and codemap sizes; 1-2 hide the codemap |
| `time`                | unset   | `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `8h` or `unlimited`: `budget.max_hours`, and the agent sizes its plan to it                                                                                                                                                                                                                                                                                                           |
| `max_tokens_per_turn` | unset   | Output cap per call: `providers.anthropic.max_tokens`                                                                                                                                                                                                                                                                                                                                                                       |
| `ask_on_start`        | `true`  | Offer these at every launch (terminal and VS Code panel); "keep, don't ask again" turns it off                                                                                                                                                                                                                                                                                                                              |

## `[plan]`: how much planning a run gets

| Key                   | Default  | Meaning                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`                | `"auto"` | `auto`: short goals try the fast path first, long ones plan. `fast`: always try one pass first. `full`: always plan milestones and tasks first.                                                                                                                                                                          |
| `kind`                | `"auto"` | `writing`: prose (a book, a report, a research document) with no tests; `code`; `auto` detects writing goals ("write me a book about…")                                                                                                                                                                                  |
| `fast_attempts`       | `2`      | Fast-path cycles on the whole goal before the planner takes over from the code as it is                                                                                                                                                                                                                                  |
| `fast_max_goal_chars` | `2500`   | In `auto`, goals longer than this plan first                                                                                                                                                                                                                                                                             |
| `helpers`             | unset    | Helpers the planner runs at once while exploring (0 = none). Unset: none, unless `context.subagents` is on                                                                                                                                                                                                               |
| `loop`                | `fast`   | Think-first loop session: think, execute, check, fix forward, re-think when stuck, one review at the end. `fast`, `all` (planned tasks too), `off`                                                                                                                                                                       |
| `loop_rounds`         | `6`      | Execute-and-check passes one loop session may take                                                                                                                                                                                                                                                                       |
| `loop_rethinks`       | `2`      | Times a loop session may stop to re-think when stuck                                                                                                                                                                                                                                                                     |
| `loop_rewinds`        | `2`      | Doom-loop rewinds per loop session: when the checks get worse twice in a row, or a set of failures comes back (fixing A breaks B and back), the tree goes back to the best pass so far, the turns since become a short tombstone ("tried X, it broke Y, don't repeat this"), and the agent re-thinks. `0` turns it off   |
| `loop_flaky_reruns`   | `2`      | Re-runs of a loop check's new test failures; a test that then passes is flaky and quarantined for the run                                                                                                                                                                                                                |
| `loop_related_tests`  | `true`   | Loop checks run the tests related to the changed files first (`vitest related`, `jest --findRelatedTests`, the changed pytest files, the changed go packages; `npm test` is read through to its script). A red there ends the round; otherwise the full gates run, so a round is only green on the whole suite           |
| `loop_think_turns`    | `8`      | Turns a think step may explore before it must write its analysis                                                                                                                                                                                                                                                         |
| `speculative_checks`  | `true`   | In a loop session, start the gates (except browser gates) in the background 1.5 s after the last edit, cancelling and restarting on further edits, one run at a time. A check reuses that result only when the working tree hashes exactly the same; otherwise it runs the gates as usual. Flaky re-runs always run live |
| `milestones`          | unset    | At most this many milestones in the first plan (the planner is told, and a bigger plan is rejected). Setting it makes `auto` plan first                                                                                                                                                                                  |

The fast path is one worker cycle with the whole goal as its task, done when every gate passes, reviewed and audited like any other cycle; it must change code to count. On the jimmy10 bench, planning first cost 3-5x a single pass on small goals. Flags: `omnexx run --plan fast|auto|full --plan-helpers N --plan-milestones N`. Autonomous runs (`--for`) always plan.

**Failures in a loop session are triaged** before they go back to the agent: failures already in the baseline are named as pre-existing (not its job unless the goal says so, not counted against it); new test failures are re-run (`loop_flaky_reruns`) and any that pass are quarantined as flaky for the run; environment problems (a command not found, a missing env var or dependency, a port in use) come back as a one-line typed hint; real failures come back as a compact Failure Packet (failing test names, the first assertion lines and project stack frames, and your diff hunks in those files) instead of a raw log, which stays readable through `read_log`. When a failure is fixed, (its signature → the agent's summary of the fix) is saved as a lesson, folded into the repo memory, and shown again when the same failure recurs.

**Writing runs** (`--kind writing`, or detected from goals like "write me a book about…"): no tests are needed. The planner writes an outline and a bible (names, facts, style rules) first, then one milestone per part and one task per chapter or section (kinds `writing` and `research`), each checked mechanically (the file exists, a minimum word count, no placeholders). An editor-style reviewer reads every piece against the bible before it is kept. The agent works as an Author through the four context scopes: general (goal and its bible notes), repo (the manuscript map, with a one-line summary of every chapter, refreshed after each commit), heat (the chapters changing most) and recent (this chapter's running notes). The run keeps adding chapters until the plan is done; an empty folder starts as a writing project (no `package.json`, `[plan] kind = "writing"`).

## `[execution]`: plan/loop presets

One knob for how hard the agent tries per task. It picks a preset that fills in `[plan]` keys you do not set yourself; anything you set explicitly anywhere still wins. Set it in `omnexx.toml` (`[execution] mode = "efficient"`) or with the `OMNEXX_EXECUTION_MODE` env var (flags > env > project file).

| Key    | Default    | Meaning                                                                                                                                                                                                                                                                                                                         |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode` | `"normal"` | `"normal"`: today's defaults, byte-identical. `"efficient"`: cheaper and faster — always tries the fast path first (`mode = "fast"`), one fast attempt, 4 think turns, 4 rounds, 1 re-think, 1 rewind, 1 flaky rerun. `"extreme"`: deeper — 3 fast attempts, 16 think turns, 10 rounds, 4 re-thinks, 3 rewinds, 3 flaky reruns. |

The preset never overwrites a `[plan]` key you set yourself (for example `loop_rounds`). Switching the mode mid-run applies at the next cycle boundary without a restart: the supervisor re-reads `omnexx.toml` and the environment each cycle, records the mode in the run state, and emits an `execution.mode_change` event with the old and new modes (no event when nothing changed). The re-read config applies as if the run had just restarted — plan/loop presets, budget, gates and review hot-apply; model chains and the judge are fixed for the run. A project file that fails to parse mid-run is ignored: the run keeps the previous config and emits `config.reload_failed`.

### `[execution] domain`: the work domain

A second, independent knob: what kind of work the run does. Set it with `omnexx run --mode <swe|general>`, `omnexx init --mode general`, the `OMNEXX_EXECUTION_DOMAIN` env var, `[execution] domain` in `omnexx.toml`, or the Work Mode selector in the VS Code panel (same precedence as everything else: flags > env > project file > user file). Switching it mid-run applies at the next cycle boundary like the posture, records `workDomain` in the run state, and emits an `execution.domain_change` event.

| Key      | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain` | `"swe"` | `"swe"`: software engineering — the full toolset including the AST tools (`outline`, `read_symbol`), prompts framed around codebases and tests, spec acceptance tests, and anti-cheat rules that police the test suite. `"general"`: general-purpose artifact work (documents, data pipelines, research) — the AST tools are not loaded, prompts frame goals, milestones and artifacts, verification is task checks (shell assertions, validators) and gates, and no test suite is expected or required. |

In the general domain, gates keep their usual meaning with one addition: `kind = "exists"` with a `path` runs no command and passes when that file or directory exists in the workspace — the basic artifact check, composable with `command` gates running a validator over the artifact. Spec tests are never written in the general domain, and the test-weakening anti-cheat rules (deleted tests, skip markers, snapshot rewrites) do not apply there — protected paths still do.

## `[context]`

| Key                     | Default                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `progress_tail`         | `5` progress entries in each cycle's context                                                            |
| `notes_max_tokens`      | `1500` (lessons file cap)                                                                               |
| `repo_map_max_tokens`   | `3000` (codebase map cap)                                                                               |
| `clear_tool_results_at` | `60000` estimated context tokens: elide old tool results over 1,000 chars                               |
| `keep_tool_results`     | `6` newest tool results never cleared                                                                   |
| `compact_at`            | `100000` estimated context tokens: summarize older turns                                                |
| `compact_keep_turns`    | `4` recent assistant turns kept verbatim                                                                |
| `lazy_tools`            | `false`; serve remember, running_context, recall, outline and read_symbol through one `more_tools` tool |
| `budget_tokens`         | unset (no cap); set by `context_level`: history is never sent above it                                  |
| `subagents`             | `false`: run agents get no `task` tool (one agent reads for itself)                                     |

In-cycle context control runs before each turn and works on every provider (details and measured costs: [architecture.md](architecture.md#working-state-context-within-a-cycle-and-a-chat)). Superseded material (re-reads, reads made stale by an edit, failed edits and commands later fixed, searches whose files were read, old narration) is pruned as soon as at least 4k tokens would go, and always past `clear_tool_results_at`, where old large tool results also become a one-line note telling the model how to get them back. Past `compact_at`, the cheap chain folds the older turns into the **working state** (done, decisions, what didn't work, open todos, key files, in progress, last error, next step), merged with the previous one; the think phase's analysis and the doom-loop tombstones are kept word for word, and the last `compact_keep_turns` turns verbatim. At least two older turns are needed, so it never re-folds on consecutive turns. With `budget_tokens` set, the kept tail is settled to 40% of it after a fold, and if the context is still over the budget the largest blocks become digests (head and tail lines, plus the `read_log` id). A failed or budget-refused fold leaves the context as is (then the digests keep it in budget), and `max_tokens_per_cycle` still ends a cycle that outgrows both. Events: `context.pruned`, `context.cleared`, `context.compacted`, `context.compact_failed`, `context.digested`. Keep `compact_at` under the smallest context window in your worker chain. When the provider's prompt cache keeps missing (a `cache.miss` event: a turn read under 80% of the previous prompt from cache), both `clear_tool_results_at` and `compact_at` scale down with the observed miss rate, to no less than half, because every miss re-sends the whole prompt. A command run again supersedes its older output. `lazy_tools` keeps five rarely called tool schemas out of the cached prefix (about 15% of the tool definitions); it stays off until a bench confirms the model still uses them.

## `[policy]`

| Key               | Default | Meaning                                                                                                                  |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `deny`            | `[]`    | Extra command names the agent's `bash` may not run                                                                       |
| `allow_network`   | `false` | Allow `curl`/`wget` (never piped into a shell)                                                                           |
| `env_passthrough` | `[]`    | Extra env var names for child processes (secret-looking names are dropped anyway)                                        |
| `auto_approve`    | `false` | Chat: answer yes to every "allow this?" guard question; `/yolo` toggles it per session. Hard-denied commands stay denied |

## `[service]`

| Key          | Default | Meaning                           |
| ------------ | ------- | --------------------------------- |
| `nice`       | `10`    |                                   |
| `cpu_quota`  | unset   | systemd `CPUQuota`, e.g. `"150%"` |
| `memory_max` | unset   | systemd `MemoryMax`, e.g. `"4G"`  |

## `[workers]` (see [workers.md](workers.md))

| Key                                                     | Default                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `max_concurrent`                                        | `1`                                                                          |
| `priority`                                              | `["aider", "opencode", "cline", "pi", "hermes", "openhands", "claude-code"]` |
| `[workers.<id>] enabled`                                | `false`. Any id is accepted; enabling one fails until M3 adapters exist      |
| `[workers.<id>] path`                                   | unset                                                                        |
| `[workers.<id>] timeout`                                | `"20m"`                                                                      |
| `[workers.<id>] route`                                  | `["tests", "lint", "small-refactor", "docs"]`                                |
| `[workers.<id>] max_runs_per_hour` / `max_runs_per_day` | `10` / `40`                                                                  |
| `[workers.<id>] cooldown`                               | `"1h"` after `quota_exhausted` or `rate_limited`                             |
| `[workers.<id>] extra_args`                             | `[]`                                                                         |

## Environment variables

`OMNEXX_HOME` (state, default `~/.omnexx`), `OMNEXX_CONFIG_HOME` (default `~/.config/omnexx`), `OMNEXX_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY`, and overrides: `OMNEXX_SANDBOX`, `OMNEXX_BUDGET_MAX_USD`, `OMNEXX_BUDGET_MAX_USD_PER_DAY`, `OMNEXX_BUDGET_MAX_HOURS`, `OMNEXX_BUDGET_MAX_CYCLES`, `OMNEXX_BUDGET_MAX_TURNS_PER_CYCLE`, `OMNEXX_MODELS_PLANNER`, `OMNEXX_MODELS_WORKER`, `OMNEXX_MODELS_CHEAP`, `OMNEXX_GIT_PUSH`, `OMNEXX_JUDGE_KIND`, `OMNEXX_JUDGE_MODE`, `OMNEXX_JUDGE_NIMBLE_URL`, `OMNEXX_NTFY_SERVER`, `OMNEXX_NTFY_TOPIC`.

## `[search]`

| Key           | Default | Meaning                                                                                                                                                                  |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `embeddings`  | unset   | `"provider:model"` on an OpenAI-compatible `/embeddings` endpoint (e.g. `"mistral:codestral-embed"`). Set it to give the agent `semantic_search` (find code by meaning). |
| `max_files`   | `4000`  | Files indexed at most. The index lives next to the repo's memory and only re-embeds files that changed.                                                                  |
| `chunk_lines` | `60`    | Lines per indexed chunk (a quarter overlap).                                                                                                                             |

## `[mcp]` (see [mcp.md](mcp.md))

| Key                  | Default  | Meaning                                                                                                                                         |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `servers.<name>`     | none     | One table per MCP server (command or url, env, allow_tools, …); see [mcp.md](mcp.md#configuration)                                              |
| `mount`              | `"lazy"` | `"lazy"`: the model gets one `mcp` tool listing the servers and mounts one when it needs it. `"eager"`: every MCP tool is sent on every request |
| `eager_under_tokens` | `3000`   | Lazy mode sends every tool anyway when all MCP tools together cost fewer tokens than this                                                       |

## `[skills]` (see [instructions.md](instructions.md#skills))

| Key             | Default | Meaning                                                                                 |
| --------------- | ------- | --------------------------------------------------------------------------------------- |
| `dirs`          | `[]`    | More folders of skills (`<dir>/<name>/SKILL.md`), read in place; `~` is the home folder |
| `import_claude` | `true`  | Also use Claude Code's skills: `~/.claude/skills` and the repo's `.claude/skills`       |

## `[agents]` (see [agent-cards.md](agent-cards.md))

| Key                         | Default | Meaning                                                                           |
| --------------------------- | ------- | --------------------------------------------------------------------------------- |
| `dirs`                      | `[]`    | More folders of agent cards (`<dir>/<name>.md`), read in place                    |
| `import_claude`             | `true`  | Also use Claude Code's agents: `~/.claude/agents` and the repo's `.claude/agents` |
| `remote.<name>.url`         | –       | A remote A2A agent: its card URL or base URL                                      |
| `remote.<name>.headers_env` | `{}`    | Headers to send: env var name, `secret:<KEY>`, or literal                         |

## `[autonomous]`

`omnexx run --for 8h "<goal>"` (or `/autonomous 8h [goal]` in the app) turns this on. Once the goal is met it
keeps planning improvement rounds until the time is up: no round cap, each round aimed at the next focus area
(yours first, then the built-in rubric), and work blocked by a parked task is skipped instead of stopping the
run to ask. `--for` also sets `budget.max_hours`; `budget.max_usd` still applies.

| Key               | Default | Meaning                                                                   |
| ----------------- | ------- | ------------------------------------------------------------------------- |
| `enabled`         | `false` | Set by `--for`                                                            |
| `max_idle_rounds` | `8`     | Stop early after this many rounds in a row that found nothing worth doing |
| `focus`           | `[]`    | Extra focus areas tried first, e.g. `["move the API to tRPC"]`            |

## `[review]`

Earned done. On by default; each part costs model calls, so tune it to your budget.

| Key                     | Default     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`               | `true`      | Review each change that passed the gates before it is committed; blocking findings send it back                                                                                                                                                                                                                                                                                                                                      |
| `review_models`         | `"worker"`  | Which role's models review (`cheap`, `worker`, `planner`). Reviews are frequent, so the worker's models keep them affordable                                                                                                                                                                                                                                                                                                         |
| `block_on`              | `"blocker"` | Severity that rejects a change (`blocker` or `major`)                                                                                                                                                                                                                                                                                                                                                                                |
| `strict_checks`         | `true`      | Refuse plans whose task checks only look for files or text                                                                                                                                                                                                                                                                                                                                                                           |
| `audit`                 | `true`      | Before a run may finish, audit the result against the goal's "done when" list; gaps become a new milestone                                                                                                                                                                                                                                                                                                                           |
| `audit_models`          | `"planner"` | Which role's models audit (rare and judgement-heavy)                                                                                                                                                                                                                                                                                                                                                                                 |
| `max_audits`            | `3`         | Audit rounds before the run finishes anyway (1 when the fast path met the goal)                                                                                                                                                                                                                                                                                                                                                      |
| `audit_max_cycles`      | `4`         | Cycles one audit round's work may take; what is still open then is skipped and the run finishes on the last green commit                                                                                                                                                                                                                                                                                                             |
| `spec_tests`            | `"off"`     | Spec-first acceptance tests before finishing: a model given only the goal and public signatures writes tests for boundaries and interactions; failures go back to the worker, who may dispute a test (a judge decides). `auto`: goals above the fast-path size or listing 5+ requirements. Off until a bench shows it pays: a suite failing most tests on green code is ignored, and a fix round that fixes no spec test is reverted |
| `spec_tests_models`     | `"planner"` | Which role's models write the spec tests and judge disputes                                                                                                                                                                                                                                                                                                                                                                          |
| `spec_tests_max_rounds` | `1`         | Fix rounds the spec tests may add before the run finishes anyway                                                                                                                                                                                                                                                                                                                                                                     |
| `spec_tests_max_cycles` | `3`         | Cycles one fix round may take before it is cut off                                                                                                                                                                                                                                                                                                                                                                                   |
| `max_diff_chars`        | `40000`     | Larger diffs are cut (head and tail kept) before review                                                                                                                                                                                                                                                                                                                                                                              |
