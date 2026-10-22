# Omnexx: Road to Frontier (TODO)

> One prompt. It runs for days. It figures out what you meant, ships it fast, then keeps going:
> hardening, testing, polishing, like the best engineer you know, until it marks itself done.

Status: drafted 2026-10-05. Branch base: `feat/brand-open-providers` (on top of `feat/swarm-pools`).
Owner: Jimmy. Executors: parallel coding agents (one per workstream, see §2).

---

## Status and work sessions (keep this current)

Single source of truth for where things stand. Update the table and append a session entry at
the end of every work session. Checkboxes in the workstream sections lag; trust this table.

| WS  | State                                                                      | Branch / PR        |
| --- | -------------------------------------------------------------------------- | ------------------ |
| W0  | extension points + CI matrix landed; nightly merge job not                 | #10                |
| W1  | TUI merged (boxes not yet audited)                                         | #14                |
| W2  | telemetry merged                                                           | #11                |
| W3  | router merged                                                              | #12                |
| W4  | merged; plus paste-a-key, `/connect`, `/chat` (#25)                        | #22, #25           |
| W5  | merged; browser gate now wired into config (#27)                           | #16, #20, #27      |
| W6  | merged (MCP)                                                               | #18 via #20        |
| W7  | merged (web fetch/search, same branch as W6)                               | #18 via #20        |
| W8  | part 2: recall + compaction facts (#28); tree-sitter, learned budgets left | #15, #28           |
| W9  | merged (intent + beyond)                                                   | #17 via #20        |
| W10 | merged                                                                     | #19 via #20        |
| W11 | `task` subagents, parallel fan-out (#29); token-saving unmeasured          | #29                |
| W12 | merged; 1 item left                                                        | #13 via #20        |
| W13 | scaffold commit only, no PR                                                | `ws/13-bench-docs` |
| W14 | 3/5 (landed with W12)                                                      | #13 via #20        |
| W15 | not started                                                                | –                  |

Next up: see [NEXT.md](NEXT.md) (owner's to-dos, the agent's queue, rules). Older backlog: W13 bench → audit W1/W2/W3/W9 boxes.
SonarCloud findings from the #20 integration merge are still open.

### Session log

- **2026-10-22 (single agent), branch `feat/speculative-cache`:** speculative cache recovered
  from the `omnexx-perf` checkout and landed: persistent AST cache (`src/core/ast-cache.ts`)
  wired into the codemap (`buildCodemapCached`, cache-aware `updateCodemap`), provider prefix
  pinning (`src/providers/cache-pinning.ts`), a cache-tracking provider wrapper
  (`cache-tracking.ts`), cache telemetry (`src/telemetry/cache-metrics.ts`), speculative file
  checks (`src/core/speculative-check.ts`), and the speculative-cache benchmark under
  `test/unit/bench` (0 re-reads on an unchanged tree, 99.5% cacheable prefix, 94.8% of prompt
  tokens read from cache). 40 new tests, all passing; typecheck/lint/format clean on the new
  files; unit suite at 1514 pass with only the 5 pre-existing bench failures.
- **2026-10-22 (single agent), branch `feat/multi-agent-swarm-core`:** merged
  `origin/main` to resolve PR conflicts; fixed the `docs/TODO.md` session-log conflict and
  verified merge commit `048d4ec`.
- **2026-10-22 (single agent), branch `feat/multi-agent-swarm-core`:** hierarchical swarm core.
  `src/workers/scratchpad.ts`: namespaced, versioned shared board (optimistic-concurrency
  claims via `putIfVersion`), append-only event log, live subscribers.
  `src/workers/ipc.ts`: in-process pipe pair over a transport-agnostic envelope
  (`{ id, kind, payload, replyTo? }`), request/reply correlation, typed timeout/closed/remote
  errors. `src/workers/file-locks.ts`: region locks (same path + overlapping inclusive line
  ranges conflict), FIFO-fair queueing per file, acquire timeouts, lazy TTL expiry.
  `src/agent/swarm.ts`: `SwarmCoordinator` running architect → implementer → red-team →
  auditor over injected executors (no model calls in the coordinator; production wiring
  adapts `helperRunner` later), region locks held across the implementer phase and released
  in a `finally`, phase outputs on the scratchpad (`spec`/`impl`/`qa`/`audit`), verdict
  `pass` only on clean QA and no blocking audit findings. 27 new unit tests, all passing;
  lint, typecheck and format green (the 5 `test/unit/bench` suite-validation failures are
  pre-existing on a clean tree, untouched here). Not committed.
- **2026-10-22 (single agent), branch `feat/vscode-bento-ui` (uncommitted, in the working
  tree):** VS Code panel redesigned to the bento-glass cockpit concepts. New shared tokens in
  chat.css (`--bento-*`, `--radius-lg`, posture gradients, role accents) underpin: an Execution
  Posture pill in the chat header and in Settings → Agent, bound to the real `[execution]` mode
  — the extension host reads the effective mode with the config loader's precedence (env >
  project omnexx.toml > user config.toml) and saves picks into the user config's `[execution]`
  table, so a running task hot-switches at its next cycle. The Agent card's sliders became
  glass rows (same `agentSettings` path), joined by a Token Budget bar and a Live Stats card fed
  by the chat state's real usage/context (cache hit, tool success rate, token usage; no latency
  row — the state carries none). Crew helpers are bento role cards (per-kind accent, a status
  dot and word, an activity line) under a telemetry strip (tokens, avg tokens/sec, est. cost,
  cache hit), and code blocks render as glass diff-stream panels using the existing
  `.diff-add`/`.diff-del` marks. Tool Access chips and a "Max Turns" slider were deliberately
  not added: the webview has no backing settings for either. Gates: typecheck and extension
  build green; unit suite unchanged (5 pre-existing bench failures, identical on a clean tree);
  lint/format complaints are the pre-existing ones in test/unit and src/core, none in vscode/.
- **2026-10-17 (owner-approved release, no bench):** `v0.19.0` / extension 0.15.0 tagged
  (`05524df`); release CI green (npm, Marketplace, Open VSX). Removed worktrees
  `omnexx-wt-b0`, `omnexx-wt-conditional-tools`, `omnexx-wt-spark`; pruned 36 stale
  `origin/*` squash-merge branches. Bench deferred.
- **2026-10-17 (single agent), PRs #224–#229, VS Code polish and context/token work:** composer
  (@ files, / commands, Send becomes Stop). Mined the 2026-10-16 bench: omnexx used 616k fresh
  tokens against Cline's 1.32M and resolved 9/10 tasks against Cline's 6/11. Fresh tokens split
  44% new content, 32% provider cache misses (Cline misses more on the same endpoint), 10% cold
  starts, 7% re-reads after compaction, 7% side calls. Fixes: a rerun command supersedes its
  older output (#226); the clear and fold thresholds scale down with the observed miss rate
  (#227); the review prefix sent `[answerTool]`, so it never hit the cache and re-sent ~20k
  uncached tokens per review. It now sends the worker's tools with `tool_choice: none`, worker
  chain only (#228). `lazy_tools` flag, off until benched (#229). Next: bench `lazy_tools` and
  #227/#228 when approved.
- **2026-10-16/17 (single agent, other agents stopped), PRs #195–#221:** finished the master
  todo; all 20 items shipped (status lines in `docs/MASTER-TODO.md`). Highlights: first call
  5,163 → 3,415 tokens (#215); `web_fetch` refuses private/metadata addresses through redirects
  (#216); Cargo related tests, parser and Rust detection (#217); a think loop that spends its
  rounds red is no longer `done` (#212); shared chat-server pipe harness (#202). VS Code panel
  redesigned (#218, #220, #221): native title-bar actions, workbench theme tokens, a one-line
  mission strip, tool calls as glyph rows, mode/model/context/cost under the input. Lesson: a
  root-owned `.git/objects` blocks every commit across worktrees; `find .git -user root` first.
  Nothing published; no benches run.
- **2026-10-15 (single agent), branch `feat/mcp-easy`:** MCP servers made easy. `src/mcp/manage.ts`
  is the one place that adds (command, URL with OAuth auto-detect, gallery, import, pasted JSON),
  lists (starts each server: status, tool count, approx tool-schema tokens), enables/disables
  (`enabled = false`), sets the tool allow-list, removes and signs in; the CLI (`omnexx mcp
gallery|list|enable|disable|allow|login|logs`), the TUI's `/mcp` and the VS Code settings
  section (`vscode/src/webview/mcp.ts`, chat-server `{type: "mcp", op}` in `cli/chat-mcp.ts`) all
  use it. Stdio servers' stderr is captured (no longer inherited into the TUI) and a failed start
  says why with its tail. Import also reads VS Code and Windsurf. SSE-only endpoints stay
  unsupported (the SDK's SSE client is deprecated and lint forbids it).

- **2026-10-15 (single agent), branch `feat/think-loop`:** the fast path is now a think-first
  loop session (`[plan] loop = "fast"`, `core/think-loop.ts`): think with the planner's models
  (explore, then an explicit analysis), execute in the same conversation with the worker's,
  gates after each pass with failures sent back to fix forward (no rollback), re-think in place
  when stuck or on the same failure twice, one review of the whole diff at the end (a finding is
  one more turn; it replaces the pre-finish audit). A session that ends red goes back to its last
  green tree; one with no green keeps its patch for the next session. Helper agents are off by
  default (`[context] subagents = false`; planner helpers too): in hard-1015 they were 24 of
  ~2,700 omnexx calls and 0.4% of tokens, 92% went to worker conversations. `loop = "all"` runs
  every planned task this way (opt-in until a bench says so). Bench confirmation pending (the
  sandbox could not source the bench env).

- **2026-10-14 (web agent), branch `feat/web-hardening`:** `web5` bench suite (offline docs
  sites served from 127.0.0.1 via `.docs/serve.sh`; unfamiliar library API, layout overflow and
  console-error pages checked in headless Chrome, rate-card lookup, v2 migration; reference
  solutions validated in `test/unit/bench/web5.test.ts`). `web_fetch`: markdown with
  headings/code/tables/links, nav/ads/cookie banners stripped, `page: N` continuation, per-run
  cache, retries with per-attempt timeouts, streamed size cap. `web_search`: retries, timeout,
  cache, clipped snippets. Browser: `text=`/`label=`/`placeholder=`/`role=` targets on both
  backends, 10 s Playwright action timeouts with a snapshot on timeout, network-idle settle on
  agent-browser, and `check_page` (screenshot, console errors, failed requests, overflow,
  overlap, broken images; `width` for phone checks). No live web5 run yet (free models only).
- **2026-10-14, branch `feat/run-estimates`:** run estimates. Each finished run (and chat work
  started by approving a plan) adds a sample to `run-history.json` next to `latency.json`: goal
  length, fast path vs planned, plan nodes, repo files, wall time, fresh/cached tokens, cost,
  model. Before a run, `omnexx run`, the TUI status bar and the VS Code panel show "est. ~3 min,
  ~40k tokens, ~$0.02 (5 similar runs)" from the medians of the 5 nearest past runs (log-scale
  distance; same model and path when there are 3+), a range when there are fewer than 3 or the
  quartiles are far apart, "no history yet" otherwise; then "~2 min left" as tasks finish.
  `src/core/run-estimate.ts`, `run-history.ts`, `run-estimate-io.ts`, `src/tui/chat-estimate.ts`.
- **2026-10-14, branch `feat/ollama-zero-config`:** zero-config Ollama. With no provider set up,
  `omnexx`, `omnexx --ollama` and the VS Code panel detect Ollama (`OLLAMA_HOST` aware), keep
  tool-capable local models (`/api/show`), rank coding models first, create an `omnexx-<model>`
  copy with `num_ctx` 32k (16k on small machines), and save it for every role. With nothing
  usable pulled they offer a one-key / one-button pull. Tests use a scripted fetch.
- **2026-10-14 (agent), branch `feat/bench-hard`:** new `hard10` bench suite
  (`bench/suites/hard10`, see its README): ten harder tasks (cross-module bug hunts, multi-file
  TS features, two SWE-bench-style issue fixes, a parity-checked refactor, a jsdom-checked
  widget, a TS+Python protocol change, a two-hotspot performance task), each with a hidden
  behavior check and a reference solution; `validate.sh` and an integration test check that every
  start fails and every reference passes. Suites now share `DirSuite`. The claude-code runner
  takes `--endpoint` via `PREFIX_ANTHROPIC_BASE_URL` (claude only speaks Anthropic Messages, so it
  bypasses the OpenAI meter and reports its own usage). No paid agent was run.
- **2026-10-13 (single agent), branch `feat/autonomy-2`:** efficiency work driven by a
  head-to-head bench (same model, DeepSeek-V4.1-Flash, for every harness; tokens counted by
  one metering proxy, `bench --endpoint <PREFIX>`). Cline and OpenHands runners added. Fixes:
  fast path (`[plan] mode`: one pass on the whole goal, planner only if it fails), planning
  effort flags (`--plan`, `--plan-helpers`, `--plan-milestones`), early "goal met" audit that
  skips padded milestones, audit scoped to what was asked, reviewer blocks only on evidence,
  review-only rejections amended instead of redone, codemap skips vendored folders and the
  fast path skips file descriptions, audit retries an empty answer, anti-cheat flags
  directives only in comments, planner falls back to the next model, `different_approach`
  ladder rung (`no_progress_cycles` 8 → 12), Nimble adapter fixed for Ollama's systemone shape,
  browser controls in Settings, 14 dead CSS rules removed. Bench (jimmy10, run 8 vs the
  first run): omnexx 9/10 (task-10 passed on rerun at 39k fresh), 8-19k fresh tokens on most
  tasks, from 63k-2.4M; Cline 9/10, OpenHands 10/10. Results in `bench/results/ds-*`.

- **2026-10-11/12 (single agent):** released 0.5.0. Fixed the flaky detach/pause process test
  (#92; it raced the run's end), retired `next` (#91), added the Homebrew formula (#90). npm
  0.5.0 published via trusted publishing (staged, approved by the owner); Homebrew tap live and
  install-tested; VS Code extension 0.1.0 on the Marketplace and Open VSX; listing PRs
  ollama/ollama#18959 and EndoTheDev/Awesome-Ollama#113.

- **2026-10-11 (single agent):** VS Code extension v1 in `vscode/` (NEXT.md item 5): runs
  sidebar with the live plan, start / autonomous / chat commands, and watch, pause, resume and
  stop per run. It only calls the CLI, through the new `omnexx runs --json` and `plan --json`.
  Packaged a `.vsix` and installed it in an isolated VS Code; no screenshot check (cua-driver
  has no Accessibility permission). Not published: needs a Marketplace publisher and Open VSX.

- **2026-10-09, later (single agent):** email connector over IMAP with an app password (#85),
  `omnexx --ollama` plus Ollama auto-connect on first run (#86), and release prep for 0.5.0 with
  `scripts/install.sh` (#87). Live checks: `--ollama` answered from a real local Ollama, and
  `serve-email` lists its tools over stdio. Publishing waits on the npm trusted publisher (see
  NEXT.md).

- **2026-10-09 (single agent, no paid live runs):** landed the #76–#79 stack into `next` (#80;
  they had merged into their parent branches), deleted 69 merged remote branches, and
  fast-forwarded `main` to `next` (#83). Autonomous mode (#81): `run --for 8h` / `/autonomous`
  keeps planning improvement rounds until the clock runs out, rotating focus areas, skipping
  parked work, stopping after `max_idle_rounds` empty rounds. Context scopes and live todos (#82):
  a `context` tool (general / repo / heat / recent, capped, read on demand, agent-written notes;
  general and repo notes persist per repo); workers keep a todo list shown live in an attached run;
  one nudge when a turn ends with open items. Connectors: `omnexx connect` / `/apps`, a catalog of
  26 free connectors (16 vendor-hosted with browser OAuth via dynamic client registration, checked
  against each server's metadata; token apps; Google via `workspace-mcp` with the user's own
  OAuth client). OAuth tokens live in `mcp-oauth.json` (0600) and refresh at run time. A live
  Bonsai run was cut short when the local LiteLLM proxy went down; nothing was learned from it.

- **2026-10-08 (context efficiency, no live runs):** `feat/context-efficiency` off `next`. Cleared
  tool results now say which call they were and, for bash, the `read_log` id that keeps them whole.
  Clearing waits until ≥ 4k tokens (or clearAt/10) would go: before, every turn past `clear_at`
  cleared one more result and broke the prompt cache each turn. Bash output clips lines over 500
  chars (minified/base64 lines used to pass whole). `turn` events carry `segments`, tokens by
  system/tools/messages/tool results by tool, so the bench can show where tokens go. Part 2:
  compaction keeps the open `todo` items (from the last call, or an earlier summary on a second
  compaction); summaries that overshoot the schema are clipped, not dropped; and when the cheap
  model fails, a fact-only summary still compacts instead of letting context grow to the cap.
  Part 3: `read` clips lines over 2k chars and stops a range at ~60k chars (a 400-line read of a
  minified or generated file used to put hundreds of KB in context).
  Part 4, first live bench of this branch (Mistral + Ollama cloud gpt-oss-120b, $0): task-01
  resolved, 88 turns, 327k tokens (82% cache reads), 3.7 min. Half the tokens went to one task
  rejected 6× for "no changes": the planner's check had escaped quotes (`grep -cE \"…\"`) and
  could never pass. Now two "no changes" rejects with identical failing check output park the task
  (`check.suspect`). Mistral 429'd on its single key: endpoints take `api_key_envs` and rotate
  keys on 429.

- **2026-10-06 (single agent):** merged #23–#26. Browser gates can now be declared
  (`kind = "browser"`, serves the app on `$PORT`); uncaught page errors count as failures; new
  projects get a `page` gate (#27). W8: `recall` over run history, compaction keeps edited files
  and last error (#28). W11: `task` subagents (#29). Found and fixed: `omnexx run` flags
  (`--budget`, `--gate`, …) never reached the supervisor (#30). Live run "build a monkey landing
  page" from an empty folder: 30/33 tasks, 21 commits, page gate on every cycle, $3.00.

- **2026-10-05 (empty-folder start):** `omnexx run` (and a goal typed into the bare `omnexx`
  session) in an empty folder now runs `git init`, writes a starter package.json, omnexx.toml with
  `--if-present` build/lint/typecheck gates plus a `node --test` gate, and AGENTS.md, then commits.
  Verified live: "build a monkey landing page" planned 13 tasks and committed M1.T01 through the gates.
  Rough edges seen: the agent's bash tool rejects heredocs (it adapted), and the gates are only
  as strict as the scripts the agent adds; no browser gate yet for new web projects.

- **2026-10-05 (integration, single agent):** dropped parallel subagents (too much clutter).
  Merged ws/5, 6, 9, 10 and 12 into `next` (#20). Declared the missing MCP/web deps and
  added fake-backend browser-gate tests for CI coverage. Root-caused the disk filling up: a
  global `merge=rizzler` driver (`cat %O %A %B > %A`) grows the file forever. The repo now
  pins `* merge=text` in `.gitattributes`. Removed 9 stale worktrees.

---

## 0. Positioning (what we are building toward)

**"Why use omnexx over Claude Code?"** (shown in `omnexx --help`, README, omnexx.org, first-run)

```
claude code / codex / opencode     omnexx
─────────────────────────────      ────────────────────────────────────────────
you drive, turn by turn             one prompt, then it drives, for hours or days
stops when the context fills        fresh context every cycle; never runs out
"done" = the model says so          done = your tests, types, lint and a browser
                                    check all pass, and nothing regressed
stops at the literal ask            infers the intended build, ships it, then
                                    hardens, tests, documents, optimises
one model per session               a local Nimble router picks the right model
                                    for every single action
you watch a spinner                 a live telemetry feed of what it is doing
                                    and why, in a dark, quiet, pretty terminal
```

Non-negotiables that make the claim true:

1. Gates (real commands) decide acceptance; the model never does.
2. Every accepted step is a git commit on `omnexx/<runId>`; every rejected step is rolled back.
3. Token efficiency is measured and published (§W13), not asserted.
4. Providers and models are 100% user-configurable; nothing vendor-specific is hardcoded beyond
   the Anthropic default.

---

## 1. How to run this TODO with concurrent agents

### 1.1 Rules for every agent

- Work in an **isolated git worktree** on branch `ws/<id>-<slug>` cut from the integration branch
  `next` (create `next` from `feat/brand-open-providers` first, §1.3).
- **Touch only the files your workstream owns** (§2 table). If you need a change in someone
  else's file, add an interface/hook in your own file and leave a `// INTEGRATION:` note plus an
  entry in `docs/integration-notes.md`. Never edit `src/cli/program.ts`, `src/config/schema.ts`
  or `src/tools/registry.ts` directly; append to your workstream's fragment instead (§1.2).
- Definition of done for every task: `npm run check` green (prettier, eslint 0 warnings,
  `tsc --noEmit`, unit+integration+chaos tests, build); new code has unit tests; docs updated
  under `docs/`; conventional commit message ending with the Co-Authored-By trailer.
- No new runtime dependency without a one-line justification in `docs/DECISIONS.md`.
  Prefer optional/peer deps for heavy things (Playwright, MCP SDK).
- Never log secrets. Every new event payload passes through the existing redaction.
- Keep the cached prompt prefix byte-stable: new tools sort deterministically, and no timestamps
  go in system prompts.
- Open a PR into `next` titled `ws/<id>: <summary>` with a test plan. Do not merge your own PR;
  the integrator agent (W0) merges.

### 1.2 Conflict-free extension points (W0 lands these first, in one day)

So that 12 agents can work at once without merge hell:

- `src/tools/registry.ts` → loads `src/tools/extra/*.ts` via an explicit barrel
  `src/tools/extra/index.ts`, where each workstream appends exactly one export line.
- `src/config/schema.ts` → `src/config/sections/*.ts`, one zod section per workstream, merged
  by a barrel. Strict objects stay strict.
- `src/cli/program.ts` → `src/cli/commands/extra/index.ts`: each command file exports
  `register(program, io, setExit)`.
- `src/core/events` → typed event names live in `src/core/event-types/*.ts` per area.
- `docs/config.md` → split per section under `docs/config/`.

### 1.3 Waves (dependency order)

```
Wave 0 (day 0-1)   W0 integrator: extension points, `next` branch, CI matrix, merge
                   feat/swarm-pools + feat/brand-open-providers
Wave 1 (days 1-7)  in parallel: W1 TUI, W2 telemetry, W3 router, W4 providers, W5 browser,
                   W6 MCP, W7 web tools, W8 context, W9 intent+beyond, W10 instructions/hooks
Wave 2 (days 6-12) W11 subagents, W12 workers, W13 bench, W14 safety, W15 release+site
Wave 3 (days 12-14) soak tests, bench run, docs pass, 0.3.0 → 1.0.0-rc
```

Target: **2 weeks wall-clock** with 8–12 concurrent agents (was 4–6 weeks serial).

### 1.4 Agent prompt template (copy, fill the brackets)

```
You are a senior engineer on the omnexx repo (~/Projects/omnexx, TypeScript, Node >= 22,
vitest, tsup). Read docs/TODO.md §1 (rules) and your workstream §W<N> in full, then
docs/architecture.md and every file listed under "Read first".
Work in a git worktree on branch ws/<N>-<slug> from `next`. Only edit files your workstream owns.
Implement every unchecked item in §W<N> in order, ticking boxes in docs/TODO.md as you go
(only within §W<N>). Write tests first for each acceptance criterion. Run `npm run check`
before each commit; commit small and often. When everything is green, open a PR into `next`
with a summary, a test plan, and any INTEGRATION notes. If blocked by another workstream,
code against the interface named in §W<N> "Contracts", stub it behind a fake, and say so in
the PR. Do not ask questions you can answer from the code; make the conservative choice and
record it in docs/DECISIONS.md.
```

---

## 2. Workstream ownership

| ID  | Workstream                           | Owns (create/edit)                                                                                    | Depends on |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------- |
| W0  | Integrator / CI                      | extension barrels, CI, `next`, release branch                                                         | –          |
| W1  | Interactive TUI (Claude Code parity) | `src/tui/**`, `src/cli/commands/{chat,watch}.ts`                                                      | W0, W2     |
| W2  | Live telemetry feed                  | `src/telemetry/**`, `src/core/event-types/telemetry.ts`                                               | W0         |
| W3  | Nimble model router                  | `src/router/**`, `src/judge/uses-route.ts`                                                            | W0, W4     |
| W4  | Providers & models UX                | `src/providers/{gemini,responses,repair}.ts`, `src/cli/commands/{providers,models}.ts`, `src/auth/**` | W0         |
| W5  | Browser tool                         | `src/tools/extra/browser*.ts`, `src/verify/browser-gate.ts`                                           | W0         |
| W6  | MCP client                           | `src/mcp/**`, `src/tools/extra/mcp.ts`                                                                | W0         |
| W7  | Web search / fetch                   | `src/tools/extra/{web_fetch,web_search}.ts`                                                           | W0         |
| W8  | Context & token engine               | `src/agent/{context,compaction,codemap}.ts`, `src/agent/cache/**`                                     | W0         |
| W9  | Intent inference + "beyond" mode     | `src/agent/{intent,beyond}.ts`, planner prompt sections                                               | W0, W8     |
| W10 | Project instructions, skills, hooks  | `src/instructions/**`, `src/hooks/**`                                                                 | W0         |
| W11 | Subagents                            | `src/agent/subagent.ts`, `src/tools/extra/task.ts`                                                    | W3, W8     |
| W12 | Worker backends                      | `src/workers/adapters/**`                                                                             | W0         |
| W13 | Benchmark                            | `bench/**`                                                                                            | W1-W9      |
| W14 | Safety & sandbox                     | `src/security/**`                                                                                     | W5, W6     |
| W15 | Release, docs, site                  | `README.md`, `docs/**` index, `.github/workflows/release.yml`, site                                   | all        |

---

## W0. Integrator and CI (wave 0)

- [ ] Push `feat/swarm-pools` and `feat/brand-open-providers`; merge both into `main`; cut `next`.
- [ ] Land extension barrels from §1.2 with zero behaviour change (snapshot test of
      `toolSpec` output and `--help` output proves byte-identical prefix and CLI).
- [ ] CI matrix: ubuntu-latest + macos-latest × Node 22, 24; required checks on `next` and `main`.
- [ ] `docs/integration-notes.md` and a nightly job that merges open `ws/*` PRs into a throwaway
      branch and runs `npm run check` to surface conflicts early.
- [ ] Merge policy: squash, conventional title, require green CI + one reviewer agent
      (`/code-review high`) on each PR.
- **Accept:** 12 dummy PRs that each add one tool/config section/command merge with no conflicts.

## W1. Interactive TUI: "works like Claude Code, but prettier"

Read first: `src/cli/program.ts`, `src/cli/brand.ts`, `src/cli/commands/inspect.ts`, `src/core/run.ts`.

Goal: running bare `omnexx` in a repo opens a full-screen interactive session that feels like
Claude Code, styled with the brand (black bg, #00FF41 primary, #00E5FF secondary, mono, hard edges).

- [ ] Choose renderer: Ink 6 (React) vs. a hand-rolled ANSI renderer. Default: Ink, record in
      DECISIONS.md. Must degrade to line mode when `!isTTY`, `TERM=dumb` or `--no-tui`.
- [ ] Layout:
  - Header bar: `omnexx` wordmark (compact), repo, branch, run id, elapsed, $ spent / budget,
    tokens in/out/cached, active model (from router), phase.
  - Main pane: conversation + streamed assistant text (markdown rendered: code blocks with
    syntax highlight, lists, tables).
  - Telemetry rail (right, collapsible with `ctrl+t`; bottom on <100 cols): live W2 feed.
  - Plan pane (`ctrl+p`): milestone → task tree with ✓ ✗ ● ○ states and progress bar.
  - Input box: multiline (shift+enter), history (↑/↓), `@file` completion, `/` command palette.
- [ ] Modes (toggle `shift+tab`, shown in footer):
  - `chat`: turn-by-turn like Claude Code (single cycle per prompt, gates optional).
  - `run`: the prompt becomes the goal; starts the long-running supervisor in the background
    (detached, survives closing the TUI); TUI attaches to it.
  - `plan`: read-only, produces a plan, asks to start.
- [ ] Slash commands: `/run`, `/stop`, `/pause`, `/resume`, `/plan`, `/diff`, `/report`, `/model`,
      `/models`, `/providers`, `/budget`, `/gates`, `/browser`, `/mcp`, `/clear`, `/compact`,
      `/cost`, `/help`, `/init`, `/doctor`, `/attach <runId>`, `/runs`, `/steer <text>`.
- [ ] `/steer` and plain typing while a run is active: appends to `goal.md` "Steering" section,
      picked up next cycle; acknowledged in the feed.
- [ ] Permission prompts in `chat` mode for writes outside the worktree and for denied-policy
      commands (y / n / always for this pattern), stored in `.omnexx/permissions.json`.
- [ ] Diff viewer: per-file unified diff with green/red, `enter` to expand, from `/diff`.
- [ ] `omnexx watch [runId]`: attach read-only TUI to any running run (local or via `--ssh host`).
- [ ] `omnexx attach` alias; detaching never stops the run (`ctrl+d` detach, `ctrl+c` twice = stop).
- [ ] First-run onboarding: banner → detect provider keys in env → offer `providers add` → offer
      `init` → show "why omnexx over claude code" card once (§0), dismissable, stored in user config.
- [ ] Themes: `dark` (default, brand), `mono` (no color), `high-contrast`. Respect `NO_COLOR`.
- [ ] Performance: render at ≤ 30 fps, batch telemetry, never block on the event file; 10k-event
      runs stay under 80 MB RSS.
- **Accept:** scripted pty tests (node-pty) for chat turn, run start/attach/detach, slash palette,
  resize to 60 cols; snapshot tests of frames; manual check against Claude Code side by side.

## W2. Live telemetry feed ("little logs of what the agent is doing")

Read first: `src/core/events*`, `src/cli/commands/inspect.ts` (logs), `docs/architecture.md`.

- [ ] Telemetry event schema (typed, versioned): `tool.start|end`, `model.call|stream|end`
      (provider, model, routed-by, tokens in/out/cached, latency, $), `route.decision`,
      `gate.start|end`, `cycle.verdict`, `commit`, `rollback`, `compaction`, `judge.*`,
      `browser.*`, `mcp.*`, `subagent.*`, `intent.update`, `beyond.task`.
- [ ] One-line humanizer per event, brand-styled, e.g.
      `    12:04:31 ▸ read   src/auth/session.ts:40-120           (1.2k tok)
12:04:32 ▸ route  edit-small → groq:llama-4-70b  nimble p=.91  48ms
12:04:35 ▸ edit   src/auth/session.ts  +12 −3
12:04:41 ▸ gate   test  ✓ 214 passed  (6.1s)
12:04:41 ✓ commit 3f2a1c9  "auth: refresh token on 401"
12:04:42 ▸ ctx    62% · cache hit 91% · $0.42 / $50`
- [ ] Verbosity levels: `quiet` (commits, gates, verdicts), `normal`, `verbose` (every tool call
      with args), `debug` (raw events). `-q/-v/-vv` flags and `/verbose` in TUI.
- [ ] Line-mode renderer for `omnexx run` without TUI and for `logs -f` (same humanizer).
- [ ] Aggregates updated live: tokens per cycle, cache hit rate, $/accepted commit, gate pass rate,
      time per task; exposed in `status --json` and the TUI header.
- [ ] Optional OpenTelemetry exporter (`[telemetry] otlp_endpoint`), off by default; no remote
      telemetry ever without opt-in.
- **Accept:** golden-file tests for every humanizer line; 50k-event replay renders < 1 s.

## W3. Nimble decision router (model per action)

Read first: `src/judge/**`, `docs/judge.md`, `src/providers/router.ts`, `src/agent/loop.ts`.

Contracts: `Router.pick(action: ActionContext, candidates: ModelProfile[]): Promise<RouteDecision>`;
`ModelProfile` from W4 (`id`, `provider`, `tags`, `contextWindow`, `supportsTools`, `vision`,
`speedTier`, `qualityTier`, optional `costTier`).

- [ ] Action taxonomy (stable enum): `plan`, `replan`, `split`, `read-explore`, `edit-small`,
      `edit-large`, `refactor`, `debug-failure`, `write-tests`, `summarize`, `compact`,
      `browser-step`, `review-diff`, `intent-infer`, `beyond-ideate`, `commit-message`.
- [ ] `ActionContext` builder: action, task title, files touched, ctx tokens, recent failure count,
      attempts on task, last verdict, ladder rung, budget remaining fraction, needs vision/tools.
      Redacted, ≤ 4 KiB, deterministic.
- [ ] Nimble `choice` question over the _user's_ candidate list (names from config, never
      hardcoded), with probabilities; timeout 300 ms local / 1 s remote; fail-open.
- [ ] Hard filters before asking: capability (tools, vision, context ≥ need), provider caps,
      cooled-down providers, user pins (`[router.pin] plan = "anthropic:opus"`).
- [ ] Fallback when Nimble abstains/unavailable: deterministic table action → role
      (planner/worker/cheap) = today's behaviour.
- [ ] Escalation coupling: ladder rung 2 forces `qualityTier = high` candidates only.
- [ ] Learning loop: log `(context, choice, outcome: accepted/rejected, tokens, latency)` to
      `~/.local/share/omnexx/router.jsonl`; `omnexx router stats` shows per-action win rates;
      optional `router.mode = "bandit"` (Thompson sampling over Nimble's top-3) behind a flag.
- [ ] Config: `[router] kind = "nimble" | "rules" | "llm"`, `mode = "advise" | "steer"`
      (default `steer` when nimble reachable), `min_probability = 0.6`.
- [ ] TUI/telemetry: every pick emits `route.decision` (shown in W2 feed).
- **Accept:** fake-Nimble tests for each action; abstain → rules path; capability filter never
  sends a vision step to a non-vision model; replay of a recorded run shows ≥ 30% of turns routed
  to cheaper/faster tiers with no drop in gate pass rate (measured in W13).

## W4. Providers and models: anyone can add anything

Read first: `src/providers/**`, `src/config/schema.ts`, `src/auth/keys.ts`, `docs/config.md`.

- [x] `omnexx providers add` (interactive + flags): presets list as _templates only_ (OpenAI,
      OpenRouter, Groq, DeepSeek, Together, Fireworks, Mistral, Gemini, xAI, Ollama, LM Studio,
      vLLM, LiteLLM, custom). Writes to user config; verifies with a 1-token call.
- [x] `omnexx providers list|remove|test <name>`.
- [x] `omnexx models add <provider:model> [--tags code,fast] [--ctx 200k] [--vision]`,
      `models list` (with live discovery via `/v1/models` where supported), `models remove`,
      `models test`.
- [x] Model profiles in config: `[models.profiles."groq:llama-4-70b"] tags=[...] context=...`;
      auto-filled from discovery when possible.
- [x] `omnexx auth set <any-provider>` stores keys in 0600 files; env still wins; macOS
      Keychain opt-in later.
- [x] Native Gemini provider (function calling, caching) and OpenAI Responses API provider.
- [x] Tool-call repair layer for weak/local models: JSON fix-ups, schema coercion, one
      re-ask with the validation error, then fail the turn (not the run).
- [ ] Pricing is optional everywhere: unknown price ⇒ tokens are still tracked, $ shown as "–",
      budget falls back to token caps. (Remove the "no price" hard error.) _Lenient resolver and
      `costOf` exist in `src/providers/profiles.ts`, but the run still uses the strict one: token
      caps must land first, or an unpriced paid model would have no spend cap._
- [x] Role shorthands stay: `planner/worker/cheap` map to router fallback when router off.
- **Accept:** a fresh user with only `GROQ_API_KEY` goes `providers add groq` → `models list`
  → `omnexx` chat turn, with no TOML editing; contract tests for each provider against recorded
  fixtures.

## W5. Browser tool

Read first: `src/tools/bash.ts`, `src/tools/types.ts`, `src/verify/**`, `src/security/**`.

- [x] `browser` tool backed by `agent-browser` CLI when present (detect in `doctor`), else
      Playwright as an optional dependency (`npx omnexx browser install`).
- [x] Actions: `open(url)`, `snapshot()` (accessibility tree, ref ids, trimmed ≤ 4k tokens),
      `click(ref)`, `type(ref,text)`, `press(key)`, `scroll`, `screenshot()` (vision models only;
      router-aware), `console()` (errors), `network(filter)`, `eval(js)` (off by default), `close`.
- [x] Session per run, headless, isolated profile in the run dir; killed on cycle end.
- [x] URL allowlist: default `localhost`, `127.0.0.1`, `*.local`; config `[browser] allow = [...]`.
- [x] Dev-server helper: `[browser] serve = "npm run dev"`, wait for port, tear down.
- [x] Browser gate: `[[gates]] kind = "browser" script = "e2e/omnexx/*.yaml"`: a tiny YAML DSL
      (open, expect text/selector, no console errors) so UI acceptance is a real gate.
- [x] Context hygiene: old snapshots replaced by one-line stubs (W8 clearing).
- **Accept:** fixture app where the agent must fix a broken button; browser gate fails before,
  passes after; disallowed URL is refused; no zombie Chromium after 100 cycles.

## W6. MCP client

- [x] Use `@modelcontextprotocol/sdk` (optional dep). stdio + streamable HTTP transports.
- [x] Config: `[mcp.servers.<name>] command/args/env | url/headers_env`, `allow_tools = [...]`.
- [x] Read `.mcp.json` (Claude Code format) for compatibility.
- [x] Tools exposed as `mcp__<server>__<tool>`, sorted, schema-normalised; lazy listing to keep
      the prefix small (tool search tool when > 20 MCP tools).
- [x] `omnexx mcp add|list|remove|test`; `/mcp` in TUI.
- [x] Results trimmed and redacted like bash output.
- **Accept:** contract tests with an in-repo fake MCP server; a filesystem MCP server works
  end to end.

## W7. Web search and fetch

- [x] `web_fetch(url)`: fetch → readability → markdown, ≤ 8k tokens, cache per run, allowlist
      respected, robots honoured.
- [x] `web_search(query)`: pluggable backends (Brave, Tavily, SearXNG, Exa) via user key; off
      when no backend configured.
- **Accept:** recorded-HTTP tests; disabled cleanly when unconfigured.

## W8. Context and token engine (our core advantage)

- [x] Measure first: per-turn breakdown of tokens by segment (system, tools, goal, plan,
      progress, codemap, history, tool results) emitted as telemetry. _`turn.segments`: system,
      tools, messages, tool results by tool._
- [ ] Prompt cache discipline: stable prefix ordering, 1h cache for the system+tools block on
      long runs, cache breakpoints placed by segment volatility; report cache hit rate.
- [ ] Tiered memory: hot (current cycle), warm (`progress.md` tail + lessons), cold (codemap,
      searchable via `recall(query)` tool backed by a local BM25/embedding index).
- [x] Smarter tool-result clearing: keep the last N results of each tool, stub the rest with a
      1-line summary + `read_log` handle. _Stubs name the call and the bash log; clears are batched
      (≥ 4k tokens) so each prompt-cache miss buys real savings._
- [ ] Incremental codemap (symbol index via tree-sitter, updated on commit, not rebuilt).
- [ ] Diff-aware reads: `read` returns "unchanged since turn X" instead of repeating content.
- [x] Compaction by cheap model (router `compact` action) with a quality check: compacted
      summary must retain open TODOs, failing test ids and touched files. _Open `todo` items,
      edited files and last error are filled in from facts; overshooting answers are clipped, and
      a failed summarizer falls back to a fact-only summary (`context.fact_summary`)._
- [ ] Token budget per action learned from history; early termination when a cycle's marginal
      tokens stop producing edits.
- **Accept:** on the bench long-horizon spec, ≥ 40% fewer input tokens per accepted commit vs.
  current `main`, gate pass rate unchanged.

## W9. Intent inference and "beyond" mode

The differentiator: it figures out what you actually want, finishes it fast, then keeps
improving like a top engineer until it declares itself done.

- [ ] Intent pass (cycle 0): read repo, README, issues/TODOs, recent commits, and the prompt;
      produce `intent.md` = inferred end product, users, definition of done, explicit
      assumptions, and _acceptance checks it will add as gates_ (tests it will write first).
- [ ] Ask-or-assume policy: unattended runs never block; ambiguous points become recorded
      assumptions surfaced in the TUI and REPORT.md (user can `/steer` to override).
- [ ] Fast path: the planner orders work for the shortest path to a working, gated v1
      ("walking skeleton first"), then widens.
- [ ] Beyond mode (`[run] beyond = true`, default on): after the goal's milestones pass, the
      planner generates a ranked backlog from a fixed rubric:
      hardening (error paths, input validation, edge-case tests), test coverage gaps, security
      (deps audit, secrets, injection), performance (profile hot paths), DX (README, scripts,
      types), accessibility (if UI, via browser), observability, refactors with tests green.
      Each item must add or tighten a gate before it can be accepted.
- [ ] Stop condition: `done` when the backlog's top expected-value item scores below a
      threshold (Nimble `score` question + rules), or budget/time reserve hit. Marks itself
      complete with REPORT.md: what was built, assumptions, what it hardened, what it would do next.
- [ ] Anti-busywork guard: reject beyond-cycles whose diff is cosmetic only, or that churn the
      same files 3× without a new passing check.
- **Accept:** on 3 bench specs, v1 lands within 20% of the time a plain run takes; beyond mode
  adds measurable coverage/lint/security wins; no run loops forever (property test on stop rule).

## W10. Project instructions, skills, hooks

- [x] Load `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `OMNEXX.md` (precedence documented),
      nested per-directory files when the agent works in that directory.
- [x] Skills: `.omnexx/skills/<name>/SKILL.md` (Claude Code format compatible), listed by name in
      the prefix, loaded on demand via a `skill(name)` tool.
- [x] Hooks: `[[hooks]] on = "pre_tool|post_tool|pre_commit|cycle_end|run_end" run = "…"`,
      non-zero exit on pre_* blocks with the hook's stderr fed back to the agent.
- **Accept:** fixtures for each file type; a pre_commit hook can veto a commit.

## W11. Subagents

- [ ] `task(description, kind = explore|research|review)` tool: read-only child agent with its own
      fresh context and a token cap; returns a ≤ 1k-token summary.
- [ ] Parallel fan-out (max N, config) for exploration during planning; router picks a fast model.
- [ ] Never writes; writes stay with the single agent in charge (keeps gates authoritative).
- **Accept:** planning on a 2k-file repo uses ≥ 50% fewer main-context tokens with subagents.

## W12. Worker backends (from PLAN §15)

- [x] Adapters: Claude Code (`claude -p`), Codex (`codex exec`), OpenCode, Aider, Cline CLI,
      Gemini CLI, Qwen Code. Each: detect, version-gate, run in its own worktree, collect diff.
- [x] Contract tests against recorded CLIs; timeout kills the process tree; quota rotation.
- [ ] Router action `delegate` can choose a worker for a well-scoped task.
- **Accept:** PLAN §M3 worker criteria.

## W13. Benchmark (proof)

- [ ] `bench/` runner: `npm run bench -- --suite lite50|jimmy10|longspec --agents omnexx,claude-code,codex`.
- [ ] Metrics: resolve rate, $/resolved, tokens/resolved, wall time, cache hit %, human
      interventions, regressions introduced.
- [ ] 24 h soak on the 40-item spec (PLAN §M3), docker sandbox, report committed.
- [ ] Publish results table in README only if the PLAN §M4 decision rule holds.

## W14. Safety and sandbox

- [ ] Docker sandbox default for unattended runs > 1 h (prompt in TUI to enable).
- [ ] Browser and MCP inside the sandbox network policy; egress allowlist.
- [x] Secret scanner on every commit (block + rollback on hit).
- [x] Destructive-command policy covers new tools (browser eval, MCP tools tagged destructive).
- [x] Threat model update in `docs/safety.md`.

## W15. Release, docs, site

- [ ] `npm i -g omnexx` → `omnexx` opens TUI onboarding on clean macOS + Ubuntu + WSL.
- [ ] README: hero banner, 30-second GIF of a run (vhs tape in repo), "why omnexx over claude
      code" table, quickstart (3 commands), providers guide, router guide.
- [ ] Trusted publishing with provenance; changesets; `0.3.0` after wave 1, `1.0.0-rc` after bench.
- [ ] omnexx.org: static brand page (BRAND.md), install command copy button, the §0 table.
- [ ] `omnexx update` self-check against npm, non-blocking notice in TUI footer.

---

## 3. Milestone checkpoints

- [ ] **Day 1:** W0 done; all workstream agents launched.
- [ ] **Day 4:** TUI chat mode usable; telemetry feed live; providers add works; router in
      advise mode logging decisions.
- [ ] **Day 7:** browser tool + gate, MCP, web tools merged; router steering; 0.3.0 published.
- [ ] **Day 10:** intent + beyond mode, context engine wins measured; subagents.
- [ ] **Day 14:** bench + 24 h soak green; README with real numbers; 1.0.0-rc.
