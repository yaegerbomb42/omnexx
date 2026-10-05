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

| Key       | Default     | Meaning                                                                                                                                                                                                                   |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | required    | Letters, digits, `_ . -`                                                                                                                                                                                                  |
| `run`     | required    | Shell command, run in the worktree with a scrubbed env                                                                                                                                                                    |
| `timeout` | `"10m"`     | Capped by `budget.max_cmd_timeout`                                                                                                                                                                                        |
| `level`   | `"ratchet"` | `"must-pass"`: exit 0. `"ratchet"`: no new failure ids and no more failures than the baseline                                                                                                                             |
| `parser`  | `"generic"` | `vitest` (`--reporter=json --outputFile=/dev/stdout`), `jest` (`--json`), `node-test` (`--test-reporter=tap`), `tsc`, `eslint` (`-f json` or default output), `pytest` (`-rf`), `gotest` (`-json`), `generic` (exit code) |

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

| Key       | Default                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `planner` | `"anthropic:opus"` → `claude-opus-5-5`                                                                 |
| `worker`  | `"anthropic:sonnet"` → `claude-sonnet-5-5`                                                             |
| `cheap`   | `"anthropic:haiku"` → `claude-haiku-4-5-20251001` (codemap purposes, notes consolidation, `llm` judge) |

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

## `[providers.anthropic]`

| Key               | Default     | Meaning                                                               |
| ----------------- | ----------- | --------------------------------------------------------------------- |
| `base_url`        | API default | e.g. a proxy                                                          |
| `cache_ttl`       | `"5m"`      | `"5m"` or `"1h"` cache writes                                         |
| `max_tokens`      | `16000`     | Output cap per turn; also the worst case used by the pre-flight check |
| `request_timeout` | `"10m"`     | Per request                                                           |

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

| Key                          | Default | Meaning                                                   |
| ---------------------------- | ------- | --------------------------------------------------------- |
| `max_consecutive_rejections` | `3`     | Same task rejected N times in a row                       |
| `max_same_signature`         | `3`     | Same normalized failure N times for a task                |
| `max_task_cycles`            | `8`     | Cycles spent on one task without finishing it             |
| `no_progress_cycles`         | `8`     | Run-level: no accepted commit in N cycles → `needs-human` |
| `no_progress_hours`          | `3`     | Same, by time                                             |
| `oscillation_window`         | `5`     | How many earlier green commits the A→B→A check looks back |

## `[context]`

| Key                   | Default                                      |
| --------------------- | -------------------------------------------- |
| `progress_tail`       | `5` progress entries in each cycle's context |
| `notes_max_tokens`    | `1500` (lessons file cap)                    |
| `repo_map_max_tokens` | `3000` (codebase map cap)                    |

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
