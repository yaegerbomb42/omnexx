# Worker backends

Omnexx stays the single agent in charge: it owns the plan, the judge, git, budgets and memory. Worker backends let it hand one tightly scoped task to another coding harness you have installed (Aider, OpenCode, Cline, Pi, Hermes, OpenHands, Claude Code), using that tool's own quota. A worker's output is **only a candidate diff**, judged by the same gates, ratchet and anti-cheat as a native cycle, then committed (with an `Omnexx-Worker: <id>` trailer) or rolled back.

> **Status in this build:** the interface, the harness-side lifecycle and the safety checks are implemented and tested with a fake worker. **No real adapters exist yet; they arrive in M3**, along with routing, quota rotation, the "second opinion" ladder rung and judge-assisted worker choice. Enabling any worker today fails with "adapter not available until M3".

## ⚠ Terms of service and account risk

Automating consumer free tiers or subscriptions can violate those services' terms and put your account at risk. Every worker is opt-in individually and off by default, and quota caps default conservatively. **Omnexx never reads, copies, stores or logs any worker's credentials**: they stay in each tool's own config. Decide per tool whether automating it is allowed for your account.

## Interface (`src/workers/types.ts`)

| Member                                          | Purpose                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`                             | e.g. `aider`                                                                                                                |
| `detect()`                                      | Installed? Path, version, capability flags parsed from `--help`.                                                            |
| `buildInvocation(task, ctx)`                    | `{argv, env, stdin?}`. `ctx` has the isolated worktree, the prompt and a prompt file.                                       |
| `timeoutMs`                                     | Wall-clock limit; the harness kills the whole process tree.                                                                 |
| `quota`                                         | `maxRunsPerHour`, `maxRunsPerDay`, `cooldownMs`                                                                             |
| `parseResult(exitCode, stdoutPath, stderrPath)` | `completed`, `failed`, `timeout`, `quota_exhausted`, `rate_limited` or `auth_required`, plus an optional summary and usage. |

## What the harness owns (`src/workers/lifecycle.ts`)

1. **Quota and concurrency.** Skips a worker in cooldown or over its hourly/daily cap (state persisted in `$OMNEXX_HOME/workers/state.json`, so cooldowns survive restarts). A semaphore enforces `[workers] max_concurrent` (default 1).
2. **Isolated worktree** on a throwaway branch from `lastGreen`.
3. **Scrubbed environment**: no supervisor secrets; `HOME` is kept so the tool finds its own config.
4. **Push disabled** with per-process git config (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`): every push URL is rewritten to a scheme that can't connect.
5. **Timeout with a process-tree kill** (SIGTERM to the process group, then SIGKILL).
6. **Output capture**: redacted stdout/stderr in `logs/worker-<id>-<cycle>.*`.
7. **Ref-tamper check**: `git for-each-ref` before and after. Any ref change outside the worker's own branch rejects the result and disables that worker for the rest of the run.
8. **Candidate diff**: everything the worker did (its commits plus uncommitted work, untracked files included) flattened into one patch against `lastGreen`, with credential files dropped, applied to the run's worktree.
9. **Same judge**: VERIFY (gates, ratchet, anti-cheat, oscillation, task checks) → COMMIT or ROLLBACK (`rejected/<cycle>-<worker>.patch`) → RECORD.
10. The worker worktree and branch are removed afterwards.

Because the worker's own auto-approve means Omnexx's command policy doesn't apply inside it, `sandbox = "docker"` (M3) is recommended for unattended worker use.

## Config

```toml
[workers]
max_concurrent = 1
priority = ["aider", "opencode", "cline", "pi", "hermes", "openhands", "claude-code"]

[workers.aider]
enabled = false          # stays false until M3
timeout = "20m"
route = ["tests", "lint", "small-refactor"]
max_runs_per_day = 40
```

Every key and default: [config.md](config.md#workers-see-workersmd).
