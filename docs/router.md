# Model router

Omnexx picks the model for each piece of work instead of using one model for everything.
Every worker cycle, planning call and (later) side call is tagged with an **action** (`plan`,
`edit-small`, `edit-large`, `refactor`, `debug-failure`, `write-tests`, `docs`,
`read-explore`, `browser-step`, `review-diff`, `compact`, …). The router then chooses one of
**your** configured models for it.

Routing happens per cycle, never per turn: switching models mid-cycle would throw away the
prompt cache, which is the largest token saving there is.

## How a model is picked

1. **Pin.** `[router] pin.<action> = "<provider:model>"` always wins.
2. **Fit.** Models that can't do the action are removed: no tool use, no vision for a browser
   screenshot, too small a context, or below the quality the action needs (an escalated task
   only gets `quality = "high"` models).
3. **Judge.** With `[judge] kind = "nimble"` (or `[router] kind = "judge"`), Nimble gets the
   action, a few redacted facts (task, kind, size, attempts, last rejection, ladder rung,
   budget left) and a one-line description of each fitting model, and chooses one. Its pick is
   taken at or above `min_probability`; the action's role chain stays behind it as failover.
4. **Rules.** Otherwise (no judge, it abstains, it's unsure, fewer than two fitting models) the
   action's role chain is used: `planner` for planning/replanning/splitting/review,
   `worker` for code work, `cheap` for summaries and compaction.

Every decision is logged as a `route.decision` event and shown in the live feed:

```
12:04:32 · route    edit-small → local:qwen-coder  judge p=0.91  48ms
```

## Describing your models

Any model in a role chain or in `models.extra` is a candidate. Profiles tell the router what
each one is good at; without one, quality and speed come from the strongest role it holds
(planner = high/slow, worker = mid/normal, cheap = low/fast).

```toml
[models]
planner = "anthropic:opus"
worker  = ["anthropic:sonnet", "groq:llama-4-70b"]
cheap   = "local:qwen3-8b"
extra   = ["openrouter:deepseek/deepseek-v4", "local:llava"]

[models.profiles."groq:llama-4-70b"]
quality = "mid"
speed = "fast"
context = 128000
tags = ["code"]

[models.profiles."local:llava"]
vision = true
tools = false
quality = "low"

[router]
kind = "auto"            # auto | rules | judge
min_probability = 0.55
pin.plan = "anthropic:opus"
```

`kind = "auto"` asks the judge only when it's Nimble (fast and free). `kind = "judge"` also
asks an `llm` judge, which costs one cheap-model call per decision.
