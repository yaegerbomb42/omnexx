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

| Key               | Default                      | Meaning                                                                                                                                                                                                                                                      |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`            | required                     | Letters, digits, `_ . -`                                                                                                                                                                                                                                     |
| `run`             | required                     | Shell command, run in the worktree with a scrubbed env                                                                                                                                                                                                       |
| `timeout`         | `"10m"`                      | Capped by `budget.max_cmd_timeout`                                                                                                                                                                                                                           |
| `level`           | `"ratchet"`                  | `"must-pass"`: exit 0. `"ratchet"`: no new failure ids and no more failures than the baseline                                                                                                                                                                |
| `parser`          | `"generic"`                  | `vitest` (`--reporter=json --outputFile=/dev/stdout`), `jest` (`--json`), `node-test` (`--test-reporter=tap`), `tsc`, `eslint` (`-f json` or default output), `pytest` (`-rf`), `gotest` (`-json`), `generic` (exit code)                                    |
| `flaky_reruns`    | `1`                          | `0`–`3`. When the gate shows new failures the parser can name, run the whole gate again; ids that then pass are flaky (event `verify.flaky`, a `flaky` lesson, a line in the report) and don't fail the cycle. Timeouts and `generic` gates are never re-run |
| `kind`            | `"command"`                  | `"browser"`: `run` starts the app with a free port in `$PORT`, the gate waits for `url`, opens it in a real browser (agent-browser or playwright-core) and runs `script`'s steps, then stops the app. Runs on the host                                       |
| `url`             | `"http://localhost:${PORT}"` | Browser gates: the page to check                                                                                                                                                                                                                             |
| `script`          | –                            | Browser gates: a YAML/TOML steps file. Without one: open, wait, the page must render content and log no console errors or uncaught exceptions                                                                                                                |
| `requires_script` | –                            | Pass without running while `package.json` has no script of this name. The empty-folder starter uses `"start"` so non-web projects never pay                                                                                                                  |

## `[budget]` (24 h defaults, plan §14.5)

| Key                    | Default  | Meaning                                                                                                                                                                                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_usd`              | `50`     | Run total. The pre-flight check before every call keeps spend under it. Hitting it → `budget-stop` (exit 3), resumable after raising it.                                                                                                    |
| `max_usd_per_day`      | `50`     | Rolling 24 h cap. Each call is pre-flighted against it; at 90%, or when a call is refused, the run pauses (status `paused`, ntfy `budget`) until half the cap is free, then resumes on its own. The wait does not count toward `max_hours`. |
| `max_hours`            | `24`     | Active wall-clock across restarts.                                                                                                                                                                                                          |
| `max_cycles`           | `300`    |                                                                                                                                                                                                                                             |
| `max_turns_per_cycle`  | `40`     |                                                                                                                                                                                                                                             |
| `max_tokens_per_cycle` | `400000` | Input + output of every call in a cycle, before cache discounts.                                                                                                                                                                            |
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

| `[providers.endpoints.<name>]` key | Default    | Meaning                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                             | `"openai"` | Chat Completions API                                                                                                                                                                                                                                                                        |
| `base_url`                         | required   | e.g. `https://api.openai.com/v1`                                                                                                                                                                                                                                                            |
| `api_key_env`                      | unset      | Env var holding the key; unset for local endpoints                                                                                                                                                                                                                                          |
| `free`                             | `false`    | Price unknown models at $0                                                                                                                                                                                                                                                                  |
| `request_timeout`                  | `"10m"`    |                                                                                                                                                                                                                                                                                             |
| `sticky_random`                    | `false`    | For a pool whose `*-random` model picks a different model each request: omnexx picks one real chat model itself and keeps it (warm prompt cache) until it reports it is out of quota, then moves to the next. The pick and exhausted models are remembered in `sticky-<name>.json` for 24 h |
| `max_usd` / `max_usd_per_day`      | unset      | Per-provider caps; also accepted under `[providers.anthropic]`                                                                                                                                                                                                                              |

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

| Key       | Default    | Meaning                                                                |
| --------- | ---------- | ---------------------------------------------------------------------- |
| `push`    | `"none"`   | `"branch"` pushes `omnexx/<runId>` (never force) after each checkpoint |
| `remote`  | `"origin"` |                                                                        |
| `open_pr` | `false`    | `true` fails: not implemented (M5)                                     |

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
| `no_progress_cycles`         | `8`     | Run-level: no accepted commit in N cycles → `needs-human`                                                             |
| `no_progress_hours`          | `3`     | Same, by time                                                                                                         |
| `oscillation_window`         | `5`     | How many earlier green commits the A→B→A check looks back                                                             |
| `repeated_tool_call`         | `3`     | In-cycle: the same tool call with identical arguments this many times ends the cycle                                  |
| `no_edit_turns`              | `15`    | In-cycle: this many turns since the last file edit (or cycle start) ends the cycle                                    |
| `burn_factor`                | `3`     | In-cycle: tokens above this × the median of recent cycles, before any edit, end the cycle (needs 3 cycles of history) |

An in-cycle signal ends the cycle as `stuck` (events `stuck.in_cycle`, then `stuck.signal`). Its partial work still goes through VERIFY, so it's committed if the gates pass and rolled back otherwise; the next attempt gets the reason as evidence, and the strategy ladder climbs one rung.

## `[context]`

| Key                     | Default                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `progress_tail`         | `5` progress entries in each cycle's context                              |
| `notes_max_tokens`      | `1500` (lessons file cap)                                                 |
| `repo_map_max_tokens`   | `3000` (codebase map cap)                                                 |
| `clear_tool_results_at` | `60000` estimated context tokens: elide old tool results over 1,000 chars |
| `keep_tool_results`     | `6` newest tool results never cleared                                     |
| `compact_at`            | `100000` estimated context tokens: summarize older turns                  |
| `compact_keep_turns`    | `4` recent assistant turns kept verbatim                                  |

In-cycle context control runs before each turn and works on every provider. Past `clear_tool_results_at`, old large tool results become a one-line note telling the model to re-run the tool. If the context is still past `compact_at`, the cheap chain summarizes the older turns into a structured summary (done, in progress, files touched, last error, next step) that is appended to the cycle's first message; at least two older turns are needed, so it never re-compacts on consecutive turns. A failed or budget-refused summary leaves the context as is, and `max_tokens_per_cycle` still ends a cycle that outgrows both. Events: `context.cleared`, `context.compacted`, `context.compact_failed`. Keep `compact_at` under the smallest context window in your worker chain.

## `[policy]`

| Key               | Default | Meaning                                                                           |
| ----------------- | ------- | --------------------------------------------------------------------------------- |
| `deny`            | `[]`    | Extra command names the agent's `bash` may not run                                |
| `allow_network`   | `false` | Allow `curl`/`wget` (never piped into a shell)                                    |
| `env_passthrough` | `[]`    | Extra env var names for child processes (secret-looking names are dropped anyway) |

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
