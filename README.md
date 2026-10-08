# omnexx

**Set a goal, walk away, come back to commits.**

Omnexx is a personal coding agent harness: one agent works on one huge task in one repo for about 24 hours with no one steering it. Your tests, typecheck and lint decide what's kept; every kept step is a small git commit on its own branch, and you get a report in the morning.

> **Alpha.** A personal tool, not a product yet. It spends your own API credits.

## Quickstart

```bash
npm i -g omnexx
mkdir monkey-site && cd monkey-site     # or cd into any repo with tests
omnexx                                  # paste an API key, then type a goal
```

That's it: you're chatting with an agent that works in your checkout and shows every step as it
goes. Type while it works to steer it; Esc stops it. For work that takes hours or days, `/run
<goal>` starts a long unattended run on its own branch: it plans, checks every step against your
tests, typecheck and lint, and keeps going. Close the terminal any time; `omnexx` re-attaches.

### Why omnexx over Claude Code, Codex or OpenCode?

| They                         | omnexx                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| you drive, turn by turn      | one prompt, then it drives for hours or days                     |
| stops when the context fills | fresh context every cycle, so it never runs out                  |
| "done" = the model says so   | done = your tests, types, lint and a real browser check all pass |
| stops at the literal ask     | infers the intended build, ships it, then hardens and polishes   |
| one model per session        | a pool of models, each used until its quota runs out             |
| "done" when the model stops  | an independent review per change and an audit before finishing   |

### Providers in one step

At the `omnexx` prompt:

- **Paste an API key**, on its own or in a sentence ("here's my mistral key …"). 25 hosted
  providers are known by name; the key is saved to a 0600 file, never shown and never sent to a
  model. `omnexx providers list` shows them all.
- **`/connect env`**: use the keys already in your environment (only the variable name is saved).
- **`/models`**: tick the models to use and how: top-first, random, or smart (Nimble picks).
  Each runs until its quota is out, then the next takes over.
- **`/connect ollama`** (or `lmstudio`, `vllm`, `litellm`): a local model, no key.
- **`/connect https://host/v1 KEY`**: any OpenAI-compatible endpoint.
- **`/chat`**: talk to a connected model directly and ask it to set up more ("add my groq key").
  Pasted keys only ever reach it as placeholders.

### Websites get checked in a real browser

Give a check `kind = "browser"` and omnexx starts your app on a free `$PORT`, opens it with
[agent-browser](https://github.com/vercel-labs/agent-browser) or playwright-core, and rejects any
change that leaves the page blank or throws a JavaScript error. New projects get this check
automatically once they have an `npm start` script.

## What it does

Omnexx is the loop around the model:

- **Fresh context every cycle.** Each cycle starts a new conversation built only from compact files on disk: the goal, a compact view of the plan, the last few progress entries, a capped lessons file and a codebase map. No transcript carries over.
- **Hierarchical, rolling-wave plan.** The planner writes milestones, then expands only the next one or two into small tasks. Nodes are never deleted, only parked with a reason.
- **Your commands are the judge.** Gates (tests, typecheck, lint, your own commands) run against a recorded baseline with a ratchet: no new failures, and the known-failure count can't go up. Anti-cheat rejects deleted tests, new `.skip`/`.only`/`@ts-ignore`/`eslint-disable`, snapshot rewrites and edits to protected files. A failed cycle is rolled back to the last green commit.
- **Stuck detection.** Repeated rejections, repeated failure signatures and A→B→A oscillation move a task up a strategy ladder (retry with evidence, then the strong model, then a planner split into smaller tasks, then park). When nothing runnable is left, the run stops as `needs-human`.
- **Budgets.** USD, hours and cycle caps for the run, a rolling daily cap that pauses and resumes, turn and token caps per cycle, and a pre-flight check before every model call so spend never overshoots by more than one turn. In the last 8% of the budget no new task starts.
- **Crash-safe.** Atomic state, a phase machine, a lock with boot-id staleness, `--detach`, and a systemd user unit or launchd agent that resumes runs after a reboot.
- **Checkpoints and a morning-after report.** Each finished milestone is tagged; `omnexx report` writes `REPORT.md` with the outcome, the plan tree, what changed, test deltas, where it struggled, spend, decisions it needs from you, and how to merge.
- **Optional docker sandbox.** `sandbox = "docker"` runs the agent's commands and your gates in a locked-down container with only the worktree mounted.
- **Any provider, with failover.** Anthropic, Gemini, the OpenAI Responses API and any OpenAI-compatible endpoint. Each role can list a chain of models; a failing or capped provider hands the call to the next. Per-provider spend caps.
- **Helpers and memory.** The agent can hand read-only questions to helper agents that run in parallel with their own context, and `recall` searches the whole run's history, not just the last few cycles.
- **Your checkout is never touched.** Work happens in a git worktree on `omnexx/<runId>`; nothing is pushed unless you opt in.

Optional: an advisory **fast judge** (Nimble on Ollama, usually on your Mac over Tailscale) that suggests the next move and flags drift. It's off by default and can never override the gates. See [docs/judge.md](docs/judge.md).

## From the plain terminal

```bash
npm i -g omnexx
omnexx --version && omnexx doctor

cd <a repo with tests>
omnexx init                   # detects package manager and gates, asks before writing omnexx.toml
export ANTHROPIC_API_KEY=...  # or: omnexx auth set anthropic
omnexx run --plan-only "Port src/legacy to strict TypeScript"
omnexx run --detach --budget 5 --hours 2 "Port src/legacy to strict TypeScript"
omnexx status && omnexx logs -f
omnexx report                 # in the morning
```

Requires Node 22+, git and (recommended) ripgrep.

## Commands

| Command                                                                 |                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `omnexx init [--yes]`                                                   | Detect gates, write `omnexx.toml`                                                                                                                                        |
| `omnexx run "<goal>"`                                                   | Plan, then cycle. `--goal-file`, `--detach`, `--budget`, `--hours`, `--gate`, `--model-worker`, `--push branch`, `--from`, `--plan-only`, `--i-know-there-are-no-checks` |
| `omnexx status [runId] [--json]`                                        | Phase, task, progress, spend, heartbeat                                                                                                                                  |
| `omnexx logs [runId] [-f] [--events\|--progress\|--cmd <id>]`           | Human view of the event log                                                                                                                                              |
| `omnexx plan [runId] [--edit]`                                          | Show the plan, or edit `goal.md` (picked up next cycle)                                                                                                                  |
| `omnexx pause\|resume\|stop [runId] [--now]`                            | Control a run; `resume` also restarts a crashed supervisor                                                                                                               |
| `omnexx resume --all`                                                   | What the service runs at boot                                                                                                                                            |
| `omnexx runs` · `diff [--since <milestone>]` · `checkpoints` · `report` | Inspect results                                                                                                                                                          |
| `omnexx service install\|uninstall\|status [--dry-run]`                 | systemd user unit (Linux) or launchd agent (macOS)                                                                                                                       |
| `omnexx doctor [--offline] [--json]`                                    | Environment checks; never prints your key                                                                                                                                |
| `omnexx auth set\|clear anthropic`                                      | Store the key in a 0600 file                                                                                                                                             |

Exit codes: `0` finished, `2` needs a human, `3` budget stop, `4` stopped by you, `1` error.

## What does not work yet

Planned for M3 and later, and not in this build:

- Ladder rung 4 (a planner-proposed different approach).
- Real worker adapters (Aider, OpenCode, Cline, Pi, Hermes, OpenHands, Claude Code). The interface, lifecycle and safety checks exist and are tested with a fake worker; enabling a worker fails with "adapter not available until M3". See [docs/workers.md](docs/workers.md).
- The benchmark harness. Token-saving claims for helpers and memory are not measured yet.
- Nothing has run longer than about 20 minutes in testing; set `--budget` and `--hours` for long runs.

Review costs: `[review]` runs on your worker models unless you set `review_models`; with a paid
worker each reviewed change is one extra call. See [docs/config.md](docs/config.md).

## Docs

[Architecture](docs/architecture.md) · [Config](docs/config.md) · [Safety](docs/safety.md) · [Judge](docs/judge.md) · [Workers](docs/workers.md) · [VPS quickstart](docs/deploy-vps.md) · [Decisions](docs/DECISIONS.md) · [Plan](docs/PLAN.md) · [Comparison](docs/comparison.md)

## License

MIT © 2026 James Yaeger
