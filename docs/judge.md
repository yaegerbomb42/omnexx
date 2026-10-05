# The fast judge (optional, advisory)

An optional decision layer: a small model answers typed questions (pick one of N options, true/false, a score) about a compact summary of the run. **It is off by default, it fails open, and it never overrides the harness:** it can't accept a cycle that failed the gates, reject one that passed, allow a command the policy denies, or override a budget, user or no-progress stop.

## Kinds

| `[judge] kind`   | What it is                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none` (default) | Makes no calls at all.                                                                                                                                                       |
| `nimble`         | Bespoke Labs' Nimble 9B on Ollama ≥ 0.35: `POST {url}/v1/systemone` with `{model, state, questions, keep_alive}`. Plain `fetch`, no extra dependency.                        |
| `llm`            | The `cheap` model role answers the same questions through a forced tool call. Costs money; every call goes through the budget pre-flight. Also usable as `fallback = "llm"`. |

The adapter sends questions as `{name, type, question, options|levels}` and accepts answers keyed by name (an object, or an array of objects with `name`). Verify this matches the Nimble release you run; if it doesn't, every call becomes a logged `judge.miss` and nothing else changes.

## Uses in this build

| Use                  | Question                                                                                                                                                                          | Effect                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next_move`          | One `choice` over `continue`, `retry_different_approach`, `split_task`, `revert_to_last_green`, `switch_to_strong_model`, `park_and_move_on`, `ask_human`, at each cycle boundary | `advise` (default): logged with the rule decision and agreement. `steer`: the pick is taken only if its probability ≥ `steer_min_probability`, the rules allow it right now, **and** it's implemented. Otherwise the rule decision stands and the reason is logged (`below_threshold`, `not_allowed`, `unavailable`). |
| `drift`              | Does this diff serve the current task and goal?                                                                                                                                   | A confident "no" adds a note to the next cycle's evidence and logs a secondary signal. Never changes the verdict.                                                                                                                                                                                                     |
| `failure_similarity` | Same root cause as the previous failure?                                                                                                                                          | Logged next to the deterministic signature; never parks anything.                                                                                                                                                                                                                                                     |
| `tool_safety`        | Could this shell command cause harm outside the task?                                                                                                                             | Log-only, fire-and-forget; skipped while the breaker is open so tools never wait on the judge. The command policy stays authoritative.                                                                                                                                                                                |

**Implemented next-move actions:** `continue`, `retry_different_approach`, `revert_to_last_green` (a rejected cycle is already rolled back, so this equals a retry), `switch_to_strong_model` (the task moves to the planner model), `split_task` (the planner splits it into smaller tasks), `park_and_move_on`, `ask_human`. All seven options are implemented. They stay in the question so the data stays comparable; if picked in `steer` mode they're logged as `unavailable`. Routing between models (M3) isn't a judge use yet.

The rules decide what's allowed: after an accepted cycle only `continue`; after a rejection `retry_different_approach`, `revert_to_last_green`, `switch_to_strong_model`, `split_task` or `park_and_move_on`; once the ladder parks a task, only `park_and_move_on`. `ask_human` comes only from the rules (nothing runnable left, or no progress).

## Failing open

Every call has a timeout (default 3 s, since the endpoint is usually remote). Connection refused, timeout, HTTP errors, malformed JSON, an answer outside the asked options, or Ollama older than 0.35 → `abstain` + a `judge.miss` event, and the run continues. After 3 consecutive misses a circuit breaker opens (`judge.unavailable`), skips calls, and lets one probe through every 10 minutes, so a Mac that wakes up is picked up again.

## Privacy and limits

State crosses the network to the machine running Ollama. Omnexx sends only a compact, deterministic, **redacted** summary (goal excerpt, current task, last result counts, recent failure signatures, diff stats, approaches tried, budget left), never whole files, env values or logs. It's capped at 16 KiB of state and 64 KiB per request (Nimble's prompt limit is 8,192 tokens); a property test checks both, and that no secret from the corpus survives.

**Ollama has no authentication.** Bind it to the Mac's Tailscale address (or loopback), never `0.0.0.0` on an untrusted network. `omnexx doctor` warns when `judge.nimble.url` is neither loopback nor a Tailscale address (100.64.0.0/10 or `*.ts.net`).

## Setup (Mac as judge, VPS as runner)

On the Mac:

```bash
ollama pull nimble
# Bind Ollama to the Tailscale interface only (find it with `tailscale ip -4`):
launchctl setenv OLLAMA_HOST 100.x.y.z:11434   # then restart the Ollama app
```

On the machine that runs Omnexx, in `~/.config/omnexx/config.toml`:

```toml
[judge]
kind = "nimble"
mode = "advise"          # start here; compare agreement before trying "steer"

[judge.nimble]
url = "http://your-mac.your-tailnet.ts.net:11434"
```

Then `omnexx doctor` reports the endpoint, reachability, latency, Ollama version and whether the `nimble` model is pulled. An unreachable endpoint is a warning; runs still start.

Events: `judge.decision` (use, questions, answers, probabilities, confidence, latency, model, input bytes, endpoint host), `judge.miss`, `judge.unavailable`, `judge.next_move` (rule, pick, probability, final, override reason), `judge.drift_flag`, `judge.similarity`, `judge.tool_flag`.
