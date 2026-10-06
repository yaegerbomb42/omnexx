# Decisions

One entry per deviation from `docs/PLAN.md` or non-obvious choice. Newest entries at the bottom.
Format: date, decision, why, alternatives considered.

---

## D1 (2026-10-03) Handoff deviations adopted wholesale

**Decision.** The Oct 3 handoff overrides the plan where they differ:

- The GitHub repo already existed, so it was cloned instead of `git init`.
- Work happens on `feat/m0-m2-core`, which is pushed with a draft PR. Nothing is pushed to `main`, nothing is force-pushed, nothing is published to npm.
- Decisions live in `docs/DECISIONS.md` (this file), not `docs/decisions.md`.
- Linux and systemd are the primary service target (the Oracle VPS); launchd is second.
- A minimum version of budget caps (per-cycle turns/tokens, pre-flight, run-level USD/hours/cycles, `warn_at`) and of stuck detection (3 signals plus ladder rungs 1, 5 and 6) moves from M3 into M1/M2.
- The Nimble fast judge (plan §13) ships in M1/M2 as a `Judge` interface with `none`, `nimble` and `llm` implementations. It is off by default.
- No CI workflow uses an API key or calls a paid API. There is no real-API nightly job; `nightly.yml` runs chaos ×200 only.

**Why.** The handoff says these are deliberate. Budget caps and stuck detection are what keep an unattended run from burning money, so no real run should exist without them.

**Alternatives.** Following plan §12 literally (no push, M3-only guards) was rejected by the handoff.

## D2 (2026-10-03) TypeScript 6.0.x instead of 7.x

**Decision.** Pin `typescript@6.0.3`.

**Why.** TypeScript 7 (the native port) is the npm `latest`, but `typescript-eslint@8.71` declares `typescript >=4.8.4 <6.1.0` as its peer range. `strictTypeChecked` linting needs the type-aware API, so lint would break or be unsupported on 7.

**Alternatives.** TS 7 with `--legacy-peer-deps` (unsupported combination, risk of silent lint gaps); dropping type-aware lint (violates the quality bar).

## D3 (2026-10-03) Model aliases and prices

**Decision.** `src/providers/pricing.ts` maps `opus → claude-opus-5-5`, `sonnet → claude-sonnet-5-5`, `haiku → claude-haiku-4-5-20251001`, with the per-MTok prices from https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-03). Every entry is overridable from `[pricing.<alias>]` in config.

**Why.** The handoff forbids invented IDs or prices. Opus 5.5 cache reads are 0.05× base input, not the usual 0.1×, so the table stores each rate explicitly instead of deriving it from multipliers.

**Alternatives.** Hard-coding multipliers (wrong for Opus 5.5 and Fable 5.1).

## D4 (2026-10-03, late) Change of direction: personal use, 24 h runs, worker backends

**Decision.** Adopt the revised plan (§14, §15) and handoff mid-M0, without restarting:

- Omnexx is a personal tool for one user. Public-product work (multi-user, marketing, comparison claims, a heavy release pipeline) is dropped or demoted. The changesets config stays because it costs nothing, but no Version-Packages workflow will be added.
- M2 gains the hierarchical plan (goal → milestones → tasks, rolling wave), the incremental codebase map, milestone checkpoints (`omnexx checkpoints`, `diff --since`), the morning-after report (`omnexx report`, auto-written at every terminal outcome) and the wrap-up reserve.
- Budget defaults become the 24 h set: `max_usd = 50`, `max_usd_per_day = 50`, `max_hours = 24`, `max_cycles = 300`, `wrapup_reserve = 0.08`.
- M0–M2 build only the `WorkerBackend` interface, the `[workers]` config (all off, `max_concurrent = 1`), the harness-side lifecycle and a fake worker for tests. No real adapters until M3, and no installed harness is ever run.

**How existing work was adapted.** At the time of the change only the plan copy was committed, and the M0 config schema was uncommitted. The schema was edited in place: new budget defaults plus `wrapup_reserve`, and a `[workers]` section where `max_concurrent`/`priority` are fixed keys and every other key is a per-worker table (`[workers.aider]`, as in plan §15.3), validated by the same strict worker schema. Unknown worker IDs are accepted. Enabling one fails at run start with "adapter not available until M3". The plan schema planned for M1 is designed as a tree from the start, so nothing has to be rewritten in M2.

**Alternatives.** Finishing M0–M1 against the old plan and retrofitting later would have meant migrating `plan.json` and the config defaults twice.

## D5 (2026-10-04) `node-test` (TAP) parser and Node-test fixtures

**Decision.** Added a `node-test` parser for `node --test --test-reporter=tap`, and every fixture repo uses Node's built-in runner. Fixture gates call `node --test` with no path.
**Why.** Fixtures must need no `npm install` (handoff §5). Node 22 rejects a directory argument to `--test`; auto-discovery works on 22 and 24 (CI caught this).
**Alternatives.** Vendoring vitest into fixtures (slow, huge); generic exit-code gates (loses failure ids, so no ratchet test).

## D6 (2026-10-04) Fixture `ts-failing-test` is plain JavaScript

**Decision.** Kept the plan's name but wrote it in ESM JavaScript.
**Why.** Compiling TypeScript inside a fixture needs `typescript` installed in it.

## D7 (2026-10-04) Task "done" is decided by the task's check commands

**Decision.** Each plan node has `checks[]` (shell commands). A cycle is _accepted_ when the gates pass the ratchet and anti-cheat; the task is _done_ only when its checks also pass (or it has none). Accepted-but-not-done commits are kept as partial progress. A task with checks that already pass before any edit is done at zero cost (plan §4.6). Plans hold 1–200 tasks (the plan said 5–200; a small goal shouldn't be padded).
**Why.** The plan says the agent can't mark tasks done; only commands can.
**Alternatives.** Letting the model declare completion (rejected: reward hacking).

## D8 (2026-10-04) Extra stuck signal `max_task_cycles`

**Decision.** A task that has used 8 cycles without finishing is stuck, even if some cycles were accepted partials.
**Why.** "Same task rejected N times in a row" never fires on a task that keeps landing tiny partial commits forever.

## D9 (2026-10-04) Every-parked ends as `needs-human`, not "finished with N parked"

**Decision.** When nothing is runnable and something is parked, the run ends `needs-human` (exit 2).
**Why.** The handoff's rung 6 says so explicitly; the plan's "finished with N parked" wording predates it. The report's section 7 lists what needs a decision.

## D10 (2026-10-04) Commits skip user hooks and signing

**Decision.** Checkpoint commits use `--no-verify`, `core.hooksPath=/dev/null` and `commit.gpgsign=false`, with a fallback identity only when none is configured.
**Why.** A pre-commit hook or a signing passphrase prompt can hang or veto an unattended run; the gates are the judge.

## D11 (2026-10-04) Deterministic commit messages and progress summaries

**Decision.** Commit subjects are `omnexx(<task>): <title>` with the agent's own final summary as the body; progress entries are facts plus the agent's summary. No cheap-model call for either.
**Why.** Model routing (planner/worker/cheap per turn) is M3. The agent's last message already is a summary and costs nothing extra. The cheap model is used where the plan requires it in M2: codemap one-liners and notes consolidation.

## D12 (2026-10-04) The report is fully deterministic

**Decision.** `REPORT.md` is built from state, plan, events and git, with zero model calls (the plan allows at most one).
**Why.** It must be writable after a budget stop, and the summary paragraph adds little over the outcome line.

## D13 (2026-10-04) Scratch space is the run's own tmp dir only

**Decision.** Outside the worktree, the agent's commands may write only inside `/tmp/omnexx-<runId>` (also its `TMPDIR`).
**Why.** The first version allowed any `omnexx-*` directory under the temp dir, and CI on Linux showed `rm -rf ../` passing when `OMNEXX_HOME` itself lived under `/tmp`.

## D14 (2026-10-04) Lock takeover is serialized

**Decision.** A stale lock is replaced only while holding a short-lived `lock.takeover` file created with `O_EXCL`, re-checking staleness inside it.
**Why.** The plain "rename the stale lock away" approach let a slow contender rename away a fresh lock another contender had just written (found by a 5-way race test).

## D15 (2026-10-04) `budgetExhausted` flag

**Decision.** When a pre-flight check refuses a call for `max_usd`, the run stops with `budget-stop` at the next boundary, even though spend is still just under the cap. The flag clears when a supervisor starts (so raising the cap and resuming works).
**Why.** Without it the run kept retrying cheap no-op cycles, parked tasks and ended `needs-human` instead.

## D16 (2026-10-04) Nimble wire format is an assumption

**Decision.** The adapter sends `{name, type, question, options|levels}` and accepts answers keyed by name (object or array). Any mismatch is a logged `judge.miss`.
**Why.** I couldn't confirm the exact schema in this session; fail-open makes a wrong guess harmless. Verify before enabling.

## D17 (2026-10-04) LLM judge probabilities

**Decision.** The `llm` judge reports the chosen option with the model's stated confidence and splits the rest evenly.
**Why.** An LLM via a tool call has no calibrated probabilities; this keeps the answer shape identical to Nimble's for logging and the steer threshold.

## D18 (2026-10-04) Workers: lifecycle only, invoked directly in tests

**Decision.** `runWorkerCycle()` is complete and tested with a fake worker, but the supervisor never calls it in this build (no routing, no adapters).
**Why.** Handoff §4.3: routing, rotation and the second-opinion rung are M3, and nothing should pretend to work.

## D19 (2026-10-04) Service unit details

**Decision.** The systemd unit uses `Restart=on-failure`, `RestartSec=30` plus `RestartSteps`/`RestartMaxDelaySec` (systemd ≥ 254 backoff; older versions ignore those two keys), `Nice`, optional `CPUQuota`/`MemoryMax`. `resume --all` stays in the foreground with attached child supervisors so the service manager sees the process tree. The node path is resolved from `PATH` (e.g. `/opt/homebrew/bin/node`) rather than a versioned Cellar path that breaks on upgrade. `install` writes the unit and enables it; it never runs `sudo` (it prints the `loginctl enable-linger` command).

## D20 (2026-10-04) Test-process entry bundled with tsup

**Decision.** Real-process tests (detach, reboot, chaos) run `test/.build/process-entry.js`, bundled by a vitest `globalSetup` from `test/support/process-entry.ts`. It runs the real CLI with a scripted provider, a warp clock (sleeps advance virtual time) and SIGKILL hooks.
**Why.** Chaos needs a real `SIGKILL` of a real supervisor; test-only scaffolding must not ship in `dist/`. `tsup` is already a dev dependency.

## D21 (2026-10-04) CI placeholder key for `doctor --offline`

**Decision.** The CI smoke step sets `OMNEXX_ANTHROPIC_API_KEY=sk-ant-ci-placeholder-not-a-key`.
**Why.** A missing key is a `doctor` failure; offline, the key is never sent anywhere.

## D22 (2026-10-04) Not implemented, by design

`openai-compat` provider (no typed stub either; `models` with another provider prefix fail with "not implemented"), `sandbox = "docker"`, `open_pr`, `max_usd_per_day` enforcement, model routing, in-cycle compaction, flaky handling, ladder rungs 2–4, real worker adapters. Each fails loudly or is documented as accepted-but-not-enforced.

## D23 (2026-10-04) Risk noted: Haiku 4.5 retirement

`claude-haiku-4-5-20251001` is the `cheap` default; Anthropic lists its retirement as "not sooner than October 15, 2026". Override `[models] cheap` or `[pricing.haiku]` when it's retired.

## D24 (2026-10-04) Owner delegated release decisions; first real-API run; 0.1.0

**Decision.** At the owner's request ("your call on all decisions; I want a working CLI and a site that shows the download"), PR #1 was merged, the real-API e2e and one full `omnexx run` were executed (total under $0.10), and the package is versioned `0.1.0` for npm.
**What the real API found.** The `remember` tool's schema was a top-level union; the Messages API requires `type: "object"` at the top of every tool schema. It's now one flat object with per-action checks in the handler, and a unit test asserts every tool schema is a plain object.
**Results.** e2e: solved in one cycle, $0.0071, 3 turns, cache-read share 0.90 from turn 3. Full run: planned, fixed, committed, finished in 20 s for $0.06.

## D25 (2026-10-05) Docker sandbox: one long-lived container per run

**Decision.** One container per run (`docker run -d … sleep infinity`), commands via `docker exec`, mounted at the same absolute paths as on the host so logs, parser locations and the path jail agree. Each command runs under `setsid` with its pgid recorded, so a timeout kills it inside the container. Defaults: `node:22-bookworm`, `bridge` network, 2 CPUs, 4 GB, 1024 pids.
**Why.** A container per command would add seconds to every `bash` call; a shared container keeps `node_modules` and caches warm across a cycle.
**Not yet.** Per-domain egress allowlist; worker backends inside the container.

## D26 (2026-10-05) Ladder rung 2: escalate to the strong model

**Decision.** The ladder is now retry with evidence → escalate model → park. Escalation sets `escalated` on the task, so its cycles use the planner model, and resets the consecutive-rejection and signature counters so the strong model gets its own three attempts; approaches tried and evidence carry over. `switch_to_strong_model` is now an implemented judge action (steer mode only).
**Why.** Cheaper than parking a task that a stronger model can solve, and bounded: an escalated task that keeps failing parks after three more rejections, or at `max_task_cycles`.

## D27 (2026-10-05) Ladder rung 3: split a stuck task; climb on stalled partial progress

**Decision.** After the strong model also gets stuck, the planner splits the task into 2–4 new tasks under the same milestone. The original is parked with `splitInto` and marked done when all of them are; tasks that depended on it now depend on the new ones. If the planner produces nothing, the task parks. `split_task` is now an implemented judge action.
**Bug fixed on the way.** The ladder only climbed on rejections, so a task that kept landing accepted-but-unfinished commits looped until the budget ran out. It now also climbs when the cycles-per-task signal fires on accepted partials, and that signal counts cycles since the task reached its current rung (`rungStartedAt`), so each rung gets its own allowance.

## D28 (2026-10-05) Rolling daily cap

**Decision.** Spend is recorded with timestamps (`spendLedger`, last 25 h). Every model call is pre-flighted against `max_usd_per_day` over the rolling 24 h window. At 90% of the cap, or after a call was refused for it, the supervisor pauses at the next cycle boundary until at least half the cap has rolled out of the window, then resumes. Pause time is excluded from `max_hours`. A cycle cut short by a budget cap before it changed anything is recorded as "interrupted": not an attempt, not a rejection, not a lack of progress.
**Why.** Refusing calls without pausing made every following cycle end before its first call, which the stuck detector then read as failure.

## D29 (2026-10-05) OpenAI-compatible endpoints, model chains and failover

**Decision.** `[providers.endpoints.<name>]` declares an OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, LiteLLM, Ollama, vLLM): `base_url`, `api_key_env` (the env var name, never the key), `free`, and optional `max_usd` / `max_usd_per_day` (also available on `[providers.anthropic]`). Each role in `[models]` takes one model or a chain. Every turn tries the chain in order, skipping providers over their own caps or cooling down. A provider that fails cools for 1 minute (transient) or 30 minutes (key, quota, unknown model), and the call moves to the next. A 400 means our request is wrong and is not retried elsewhere. When every provider is over its cap, the cycle ends as a budget stop. When all are failing, the normal outage backoff applies.
**Scope.** Prompt caching on OpenAI-compatible endpoints is whatever they do on their own: no breakpoints are sent; reported cached tokens bill at the cache-read rate. Single-shot helpers (judge, codemap purposes, notes consolidation) use the first model of the `cheap` chain without failover.
**Why no SDK.** One `fetch` adapter covers every compatible endpoint, and the runtime dependency list stays fixed.

## Built-in swarm model pools (2026-10-05)

Jimmy asked for his swarm gateway's model pools to be hardcoded. `src/providers/pools.ts` lists the five pools and a default `swarm` endpoint that the config schema always injects, so `swarm:<pool>` works with no endpoint block. The key comes only from `SWARM_API_KEY`; the sample client's fallback key was not copied, because no key lives in code. The pools are priced at $0 (`free = true`), so they count against no USD cap; add `[pricing.<pool>]` if that changes. Unknown pool names fail at config resolution rather than at the first request. A user-declared `[providers.endpoints.swarm]` wins over the default.

## In-cycle compaction is local, not server-side (2026-10-05)

Plan §3.6 prefers Anthropic's server-side context editing and compaction where available. Chains now mix Anthropic with OpenAI-compatible endpoints (swarm pools, OpenRouter, Ollama), so a turn can fail over mid-cycle to a provider without those features. The harness therefore does both steps itself, before each turn, on the provider-neutral message list: elide old tool results past `clear_tool_results_at`, then have the cheap chain write a `CycleSummary` past `compact_at`. Server-side edits can be added later as an Anthropic-only optimization. Compaction needs at least two older turns, which stops a summary call on every turn once a long tail sits near the threshold (found by the integration test). Token counts are the existing 3 chars/token estimate, so thresholds err on the early side.

## Cheap-model side calls use the whole cheap chain (2026-10-05)

The judge, codemap descriptions and notes consolidation called only the first cheap model, without a route, so a non-Anthropic `cheap` model was sent to Anthropic. They now go through `Run.cheapComplete`, which walks the chain like a worker turn: skip blocked providers, pre-flight each model at its own price, route, fail over, and record spend per provider. Compaction summaries use the same path.

## Flaky tests: re-run the whole gate, not just the failing ids (2026-10-05)

Plan §3.8 says to re-run only the failing ids. Selecting tests by id differs per runner (vitest `-t`, pytest node ids, `go test -run`, node's `--test-name-pattern`) and the parsers' ids don't map back cleanly for all of them, so a wrong filter could "pass" by running nothing. Instead, a gate with new, parser-named failures runs again in full, `flaky_reruns` times (default 1). The verdict comes from the last run, so a persistent or different new failure still rejects. The cost is one extra gate run, paid only on a failing cycle. Ids that recovered are written as `flaky` lessons (deduplicated; skipped when the lessons file is full) and listed in the report. Timeouts and unstructured (`generic`) gates are never re-run, since there is no id to call flaky. The baseline is not re-run: a flaky failure captured at baseline only makes the ratchet more lenient for that id.

## In-cycle stuck signals end the cycle, they don't reject it (2026-10-05)

The three in-cycle signals from plan §3.10 (repeated identical tool call, no edits after K turns, token burn) stop the agent loop at a turn boundary with end `stuck`. VERIFY still runs: the cycle hard cap already treats partial work as "rolled back unless the gates pass", and the same rule applies here, so a model that fixed the bug and then wandered still gets its commit. The signal goes into the pending verdict like oscillation, so the ladder climbs whether the cycle was accepted or rejected. Burn rate is "no edit yet and tokens above `burn_factor` × the median of the last 20 cycles"; it is off until 3 cycles exist, so the first cycles of a run can't trip it. "Edit" means a file the edit tools touched; changes made through `bash` don't count, which only makes `no_edits` fire sooner.

## D30 (2026-10-05) Dependencies for MCP client and web tools (W6 + W7)

`ink` 8 and `react` 19 are runtime dependencies for the interactive session (bare `omnexx`,
`omnexx watch`). Ink is what Claude Code and most modern agent CLIs use; a hand-rolled ANSI
renderer would cost weeks for the input editing, layout, resize and `<Static>` scrollback we get
for free. The TUI is a separate chunk loaded by dynamic import, so non-interactive commands
(`run`, `status`, `logs`, services) never parse React.

## D30 (2026-10-05) W5 Browser Tool Backends and Gate DSL

**Decision.**

1. Auto-selection order for browser backends: check `agent-browser` on PATH first (spawn CLI with isolated session per run), then dynamically import `playwright-core` if installed. If neither is available, the tool is omitted from registered extra tools and `browserDoctorCheck()` produces an actionable warning for `omnexx doctor`.
2. Browser Gate DSL: supports YAML and TOML via a simple zero-dependency YAML step parser and `smol-toml`. Steps include `open`, `click`, `type`, `expect_text`, `expect_selector`, `expect_no_console_errors`, and `wait_ms`.
3. Process cleanliness: `AgentBrowserBackend` uses explicit sessions and calls `agent-browser close` per run. A process exit hook is registered to prevent orphan processes.
4. Vision model gating: screenshots return base64 image data only if `supportsVision` is set on the context; otherwise an informative text message is returned.

**Decision.** Added `@modelcontextprotocol/sdk` for MCP client transport/protocol, plus `@mozilla/readability` and `linkedom` for `web_fetch` HTML parsing.
**Why.** Allowed dependencies explicitly listed in `docs/agent-prompts.md` §W6+W7. `@modelcontextprotocol/sdk` handles official MCP framing, transports (stdio and HTTP/SSE) and protocol negotiation. `linkedom` provides a lightweight, pure-JS DOM implementation that runs cleanly on Node >= 22 without native browser binaries, pairing with Mozilla's reader mode parser (`@mozilla/readability`) to convert web pages into readable text/markdown while respecting token budgets.
**Alternatives.** Hand-rolling the JSON-RPC MCP wire protocol (risks protocol drift and subtle transport bugs); using full headless browsers like Playwright for simple web reading (unnecessary overhead and external browser downloads for non-interactive pages).

## W12 & W14 Worker Adapters, Headless Execution, and Secret Scanner (2026-10-05)

**Decision.**

1. **Worker Backend Adapters:** Implemented adapters for `claude-code`, `codex`, `opencode`, `aider`, `gemini-cli`, `qwen-code`, and `cline`.
   - Each adapter strictly builds argv arrays (never shell strings).
   - Each adapter executes within the isolated throwaway worktree prepared by `runWorkerCycle`.
   - Headless execution for Cline CLI is supported via `cline --json --auto-approve true --cwd <wt> <prompt>`. Detection verifies support for non-interactive JSON execution.
   - Credentials of the tools are never accessed, copied, or logged; the environment passed to workers is scrubbed of all supervisor secrets.
   - Exit codes and outputs are mapped to canonical quota and status types (`completed`, `failed`, `timeout`, `quota_exhausted`, `rate_limited`, `auth_required`).
2. **Secret Scanner:** Candidate commits are scanned before commit via regex patterns for common key structures (Anthropic, OpenAI, GitHub classic/PAT, AWS, Slack, NPM, JWT, Google AI, GitLab, Stripe, HuggingFace, PEM) plus Shannon entropy analysis on added diff lines (`+` lines).
   - An allowlist config section `[security] secret_allow = ["path-glob"]` is provided to exempt known test fixtures or sample data.
   - Tested to ensure zero false positives across all existing omnexx source code while detecting all seeded secret tokens.
3. **Extra Tool Policies:** Extended policies prohibit browser JavaScript evaluation (`eval` / `execute_script`) by default, require policy approval for destructive MCP tools, and verify that worker backends execute exclusively in isolated worktrees.

## W10 instructions, skills and hooks (2026-10-05)

**Decision.**

- Instruction precedence is the prompt's list (OMNEXX.md → AGENTS.md → CLAUDE.md →
  `.cursor/rules/*.mdc` sorted → `.github/copilot-instructions.md`), then nested
  AGENTS/CLAUDE shallow → deep. The 8k-token budget cuts from the _end_ of that render order
  (deepest nested first, `OMNEXX.md` last) and every cut file is named in a footer note; a
  single oversized file keeps its head with a `… (truncated)` marker.
- `renderInstructions()` keeps the zero-argument signature from the agent prompt:
  `loadInstructions()` stores its result and render uses it (tests pass an explicit value). An
  empty render is `''` so the prompt wiring can skip the block.
- Hook block feedback is the trimmed **2 000-char tail** of the hook's combined output, because
  the shared `Executor` interleaves stdout and stderr and has no separate stderr channel. A
  timed-out `pre_*` hook blocks like a non-zero exit.
- `match` is a `*`/`?` glob over the payload's tool name and is ignored on events without one
  (`cycle_end`, `run_end`).
- The `skill` tool always registers (even with zero skills) so the tool list — and with it the
  cached prompt prefix — does not change when skills appear or disappear; skill names go in the
  prompt instead, and a repo skill shadows a user skill of the same name.
- The hooks config is an `[[hooks]]` **array** of strict tables (not an object), matching the
  TOML syntax the TODO specifies; `timeout` defaults to `30s` per table.

**Why.** Byte-stable rendering is a hard requirement of the cached prefix, so every ordering
decision above is fixed and tested; the tail-trim keeps the veto reason useful without letting a
noisy hook flood the agent's context.

**Alternatives.** Dropping lowest-precedence files without a note (hides what the model can't
see), a separate stderr channel in `ExecOptions` (would touch shared `src/core/exec.ts`), and
conditionally registering the `skill` tool (would invalidate the prompt cache whenever skills
changed).

## 2026-10-05: Runtime dependencies for MCP and web tools (integration)

The W6/W7 branch imported `@modelcontextprotocol/sdk`, `linkedom` and `@mozilla/readability`
without declaring them, so its CI failed. They are now runtime dependencies. The MCP SDK is the
reference client and MCP is core; `linkedom` + Readability turn fetched HTML into readable text
without a headless browser. Playwright stays an optional peer: the browser tool prefers the
installed `agent-browser` CLI.
