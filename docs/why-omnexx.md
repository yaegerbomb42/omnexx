# Why omnexx?

> **Set a goal. Walk away. Come back to commits.**

Omnexx is a **personal coding agent harness** designed for one thing: running a single huge task for ~24 hours with no human steering, where **your tests, typecheck, and lint decide what's kept**—not the model.

## The problem with current agents

| Claude Code / Codex / OpenCode | omnexx                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| You drive, turn by turn        | One prompt, then it drives for hours or days                                       |
| Stops when context fills       | Fresh context every cycle; never runs out                                          |
| "Done" = the model says so     | Done = your tests, types, lint, and browser checks all pass, and nothing regressed |
| Stops at the literal ask       | Infers the intended build, ships it, then hardens, tests, documents, optimizes     |
| One model per session          | A local Nimble router picks the right model for every single action                |
| You watch a spinner            | Live telemetry feed of what it's doing and why, in a dark, quiet, pretty terminal  |

## Non-negotiables that make the claim true

1. **Gates decide acceptance** – Real commands (tests, typecheck, lint, your custom scripts) run against a recorded baseline with a ratchet: no new failures, and the known-failure count can't go up. Anti-cheat rejects deleted tests, new `.skip`/`.only`/`@ts-ignore`/`eslint-disable`, snapshot rewrites, and edits to protected files. A failed cycle is rolled back to the last green commit.

2. **Every accepted step is a git commit** – On branch `omnexx/<runId>`. Every rejected step is rolled back. Your checkout is never touched.

3. **Token efficiency is measured and published** – Not asserted. The benchmark harness (W13) tracks resolve rate, $/resolved, tokens/resolved, wall time, cache hit %, human interventions, and regressions introduced.

4. **100% user-configurable providers** – Nothing vendor-specific is hardcoded beyond the Anthropic default. Bring your own OpenRouter, Groq, Ollama, LM Studio, LiteLLM, or custom gateway.

## How it works (the loop)

```
omnexx run
  └─► Planner: writes hierarchical plan (milestones → tasks)
       └─► Cycle (repeats until done or budget):
            ├─► Select: pick next runnable task
            ├─► Act: agent writes code (fresh context each cycle)
            ├─► Verify: run gates against baseline + ratchet
            ├─► Commit | Rollback: keep only green steps
            ├─► Record: update progress, lessons, codemap
            └─► Guard: budgets, stuck detection, wrap-up reserve
```

### Fresh context every cycle

Each cycle starts a new conversation built only from compact files on disk:

- `goal.md` – the original intent
- `plan.json` – hierarchical, rolling-wave plan
- `progress.md` – last few cycle summaries
- `lessons.md` – capped file of learned patterns
- `codemap.json` – compact map of files touched

No transcript carries over. The model never "runs out of context."

### Hierarchical, rolling-wave plan

The planner writes milestones first, then expands only the next one or two into small tasks. Nodes are never deleted, only parked with a reason. A milestone is done only when its tasks are done **and** its checks pass on `lastGreen`.

### Stuck detection + strategy ladder

Repeated rejections, repeated failure signatures, and A→B→A oscillation move a task up a ladder:

1. Retry with evidence
2. Escalate to the strong model (stuck counters restart)
3. Planner splits into 2–4 smaller tasks (original is done when they are; dependents rewired)
4. Park; run-level stop-and-ask when nothing runnable or no progress for 8 cycles / 3h

### Budgets with pre-flight

Before each model call: worst-case = estimated input × highest input rate + `max_tokens` × output rate. Per-cycle turns/tokens, run USD/hours/cycles, 80% warning, wrap-up reserve. In the last 8% of the budget no new task starts.

### Crash-safe resume

Atomic state, a phase machine, a lock with boot-id staleness, `--detach`, and a systemd user unit or launchd agent that resumes runs after a reboot.

### Checkpoints and morning-after report

Each finished milestone is tagged `omnexx/<runId>/<milestone>`. `omnexx report` writes `REPORT.md` with eight sections: outcome, plan tree, what changed, test deltas, where it struggled, spend, decisions needed from you, and how to merge.

### Optional docker sandbox

`sandbox = "docker"` runs the agent's commands and your gates in a locked-down container with only the worktree mounted.

## Personal use, not a product

Omnexx is built for **one user (Jimmy)** on his Mac and Oracle VPS. No multi-user features, no marketing, no public comparison claims. The npm package and landing page stay simple. Priority is anything that makes long, huge-task runs succeed.

## Benchmark proof (W13)

`npm run bench -- --suite jimmy10 --agents omnexx,claude-code,codex --out bench/results/`

Metrics: resolve rate, $/resolved, tokens/resolved, wall time, cache hit %, human interventions, regressions introduced.

Results are published only if the decision rule in PLAN §M4 holds.

## Get started

```bash
npm i -g omnexx
omnexx --version && omnexx doctor
cd your-repo
omnexx init
export ANTHROPIC_API_KEY=...
omnexx run --detach --budget 5 --hours 2 "Your huge task here"
```

Read the [Quickstart](quickstart.md) → [Providers Guide](providers-guide.md) → [Configuration](config.md).
