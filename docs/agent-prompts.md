# Agent prompts (paste one per chat)

Assignment:

- **Claude (Opus 5.5) does the hard and UI work:** W0 integrator, W1 TUI, W2 telemetry, W3 Nimble
  router, W8 context engine, W9 intent + beyond mode, final merge and review of every PR.
- **Other agents do grunt work:** below. Launch only after W0 is merged into `next`.

| Chat           | Workstreams                      | Why this agent                         |
| -------------- | -------------------------------- | -------------------------------------- |
| Cline #1       | W4 providers & models UX         | Many small CLI and config edits, tests |
| Cline #2       | W10 instructions, skills, hooks  | Pure file loading and parsing          |
| Antigravity #1 | W5 browser tool                  | Has its own browser; can test the tool |
| Antigravity #2 | W6 MCP client + W7 web tools     | SDK wiring and recorded-HTTP tests     |
| Grok           | W12 worker adapters + W14 safety | Adapter boilerplate, contract tests    |
| Ollama         | W13 bench scaffolding + W15 docs | Lowest-risk, no core files touched     |

---

## Shared preamble (already included in every prompt below)

```
You are working on omnexx, a TypeScript CLI coding agent (Node >= 22, vitest, tsup, zod, commander)
at ~/Projects/omnexx. Repo: github.com/yaegerbomb42/omnexx.

Before writing code, read in full: docs/TODO.md sections 1 and 2 and your workstream section,
docs/architecture.md, docs/integration-notes.md, and every file under "Read first".

Hard rules:
1. Create a git worktree: `git worktree add ../omnexx-<branch> -b <branch> origin/next`, work only there.
2. Only create or edit files listed under "You own". Never edit src/cli/program.ts,
   src/config/schema.ts, src/tools/registry.ts or another workstream's files. Register your tool,
   config section or command by adding ONE export line to the matching barrel
   (src/tools/extra/index.ts, src/config/sections/index.ts, src/cli/commands/extra/index.ts).
   If you need anything else changed, write it in docs/integration-notes.md under your workstream.
3. Match the surrounding code style: strict TypeScript, no `any`, zod strictObject for config,
   small pure functions, comments only where intent is not obvious, ESM imports with .js suffix.
4. Tests first for every acceptance criterion. Unit tests in test/unit/<area>/, integration in
   test/integration/. No network in tests: use fakes or recorded fixtures.
5. `npm run check` must be fully green before every commit (prettier, eslint 0 warnings,
   tsc, all tests, build). Never disable a lint rule or skip a test to get green.
6. Never log, print or commit secrets; new event payloads go through the existing redaction.
7. No new runtime dependency unless the section allows it; record any in docs/DECISIONS.md.
8. Commit small, conventional-commit messages (feat(area): …), push your branch, open a PR into
   `next` with: summary, checklist of items done, test plan, integration notes. Do not merge.
9. Tick the boxes for your workstream in docs/TODO.md as you finish them (only in your section).
10. Don't stop to ask questions you can answer from the code. Make the conservative choice,
    record it in docs/DECISIONS.md, and continue until every item is done.
```

---

## Cline #1: W4 providers and models

```
[paste shared preamble]

Workstream W4: Providers and models: anyone can add anything. Branch: ws/4-providers.

Read first: src/providers/*.ts, src/auth/keys.ts, src/cli/run-deps.ts, src/cli/commands/doctor.ts,
docs/config.md, src/config/sections/ (barrel), test/unit/providers/.

You own: src/providers/{gemini,responses,repair,discovery,profiles}.ts,
src/cli/commands/{providers,models}.ts, src/auth/**, src/config/sections/models-profiles.ts,
docs/config/providers.md, and tests for these.

Do, in order:
1. Pricing optional: in src/providers/pricing.ts behaviour (via a new exported resolver in
   profiles.ts that run-deps can switch to; leave an INTEGRATION note), an unknown price no longer
   throws. Tokens are still counted, cost is `undefined`, budgets fall back to token caps,
   and display shows "–". Unit-test cost accounting with mixed priced and unpriced models.
2. Model profiles: config `[models.profiles."<provider>:<model>"]` with tags (string[]),
   context (int tokens), tools (bool, default true), vision (bool, default false),
   speed ("fast"|"normal"|"slow"), quality ("low"|"mid"|"high"). Export
   `type ModelProfile` and `listProfiles(config): ModelProfile[]`. W3 (router) depends on this
   exact shape: keep it.
3. Discovery: `discoverModels(endpoint)` calls GET {base_url}/models (OpenAI format) and
   Ollama /api/tags; returns ids plus context length when reported. 5 s timeout, fail soft.
4. `omnexx providers add [name]` interactive (readline, no new deps) and flags
   (--base-url, --key-env, --free). Templates (only as suggestions, written into user config):
   openai, openrouter, groq, deepseek, together, fireworks, mistral, gemini, xai, ollama,
   lmstudio, vllm, litellm, custom. Writes ~/.config/omnexx/config.toml without destroying
   comments (append a block; refuse if name exists). Then runs a 1-token test call.
   Also `providers list|remove|test <name>`.
5. `omnexx models add <provider:model> [--tags a,b] [--ctx 200000] [--vision] [--no-tools]
   [--speed fast] [--quality high]`, `models list [--provider x] [--remote]` (remote = discovery),
   `models remove`, `models test <ref>` (one tool-call round trip).
6. `omnexx auth set|clear <any-provider>` storing <configHome>/credentials/<name>.key at 0600.
   Lookup order: OMNEXX_<NAME>_API_KEY, the endpoint's api_key_env, the credentials file.
   Keep Anthropic's existing behaviour and tests passing.
7. Native Gemini provider (generateContent with function calling, usage metadata) and OpenAI
   Responses API provider (`kind = "responses"` endpoint), both implementing the existing
   Provider interface in src/providers/types.ts. Recorded-fixture tests only.
8. Tool-call repair (repair.ts): fix trailing commas, single quotes, code fences, stringified
   JSON args, and coerce to the tool's zod schema; if still invalid, return one re-ask message
   containing the validation error; after one failed re-ask, fail the turn (not the run).
   Exported as a wrapper `withToolRepair(provider)`.

Acceptance: with only GROQ_API_KEY set and a fake server standing in for Groq,
`providers add groq` → `models list --remote` → `models test groq:<id>` all succeed in an
integration test with no hand-edited TOML. All existing tests still pass.
```

## Cline #2: W10 project instructions, skills, hooks

```
[paste shared preamble]

Workstream W10. Branch: ws/10-instructions.

Read first: src/agent/prompts.ts, src/agent/context.ts, src/tools/types.ts, src/core/run.ts
(cycle lifecycle), src/git/*.ts (commit path).

You own: src/instructions/**, src/hooks/**, src/tools/extra/skill.ts,
src/config/sections/hooks.ts, docs/instructions.md, docs/hooks.md, tests.

Do:
1. loadInstructions(repoRoot, cwdInRepo): reads OMNEXX.md, AGENTS.md, CLAUDE.md,
   .cursor/rules/*.mdc (frontmatter stripped), .github/copilot-instructions.md, in that
   precedence; plus nested AGENTS.md/CLAUDE.md in parent dirs of files the agent is working on.
   Cap 8k tokens total (truncate lowest-precedence first, note truncation). Deterministic
   order so the prompt prefix stays byte-stable. Export `renderInstructions(): string`.
   Leave an INTEGRATION note for where prompts.ts should include it (Claude will wire it).
2. Skills: discover .omnexx/skills/*/SKILL.md and ~/.config/omnexx/skills/*/SKILL.md
   (Claude Code frontmatter format: name, description). `listSkills()` gives name +
   description for the prefix; tool `skill({name})` returns the body (≤ 6k tokens).
3. Hooks config: [[hooks]] on = "pre_tool"|"post_tool"|"pre_commit"|"cycle_end"|"run_end",
   run = "<shell>", match = optional tool-name glob, timeout = "30s".
   runHooks(event, payload) executes via the existing command runner with payload as JSON on
   stdin and env OMNEXX_EVENT. pre_* non-zero exit → returns {blocked: true, reason: stderr
   (trimmed 2k)}. Export a typed API; leave INTEGRATION notes for the call sites.
Acceptance: fixture repos for every instruction file type; a pre_commit hook returning 1
blocks with its stderr; skills tool returns the right body; byte-stable rendering test.
```

## Antigravity #1: W5 browser tool

```
[paste shared preamble]

Workstream W5: Browser tool. Branch: ws/5-browser.

Read first: src/tools/bash.ts, src/tools/types.ts, src/tools/read.ts (output trimming),
src/verify/*.ts (gates), src/security/*.ts, src/config/sections/ barrel.

You own: src/tools/extra/browser.ts, src/tools/extra/browser/**, src/verify/browser-gate.ts,
src/config/sections/browser.ts, test fixtures under test/fixtures/browser-app/, docs/browser.md.

Allowed dependency: playwright-core as an OPTIONAL peer dependency only (dynamic import).

Do:
1. Backend interface BrowserBackend { open, snapshot, click, type, press, scroll, screenshot,
   console, close }. Two backends: AgentBrowserBackend (spawns the `agent-browser` CLI if on PATH,
   parses its snapshot output with element refs) and PlaywrightBackend (dynamic import of
   playwright-core; clear error with install hint if missing). Auto-select: agent-browser, else
   playwright, else the tool is not registered and `doctor` reports why (leave INTEGRATION note
   for the doctor check; export `browserDoctorCheck()`).
2. Tool `browser` with zod schema {action: enum, url?, ref?, text?, key?, direction?}.
   Snapshot output: accessibility tree with refs, trimmed to 4k tokens with a "…N more nodes"
   footer. screenshot returns an image block only when the active model profile has vision
   (accept a `supportsVision` flag on the tool context; default false → returns a text notice).
3. Config [browser]: enabled (default true when a backend exists), allow = ["localhost",
   "127.0.0.1", "*.local"] (glob hosts), serve = optional dev-server command, serve_port,
   serve_timeout = "60s", headless = true. Disallowed URLs are refused with a clear message.
4. Lifecycle: one browser session per run stored in the run dir profile; closed at cycle end and
   on process exit; kill the whole process tree. Dev server started on first `open` of a
   localhost URL when `serve` is set, health-checked on the port, torn down at cycle end.
5. Browser gate: [[gates]] kind = "browser", script = "path/to/check.yaml". YAML DSL steps:
   open, click, type, expect_text, expect_selector, expect_no_console_errors, wait_ms.
   Produces the same GateResult shape as command gates (pass/fail counts, failure ids).
   Write the YAML parser with the existing deps (smol-toml is TOML; implement a tiny YAML subset
   or accept the same steps in TOML: choose TOML if simpler and record it in DECISIONS.md).
6. Telemetry: emit browser.open/action/close events (typed in src/core/event-types/browser.ts).
Acceptance: test/fixtures/browser-app is a static page with a broken button; integration test
(skipped when no backend available, run in CI with playwright installed) shows the gate failing,
then passing after the fix; disallowed URL refused; no orphan browser processes after 20 open/close
cycles (assert via process list).
```

## Antigravity #2: W6 MCP client and W7 web tools

```
[paste shared preamble]

Workstreams W6 + W7. Branch: ws/6-mcp-web.

Read first: src/tools/types.ts, src/tools/registry.ts, src/tools/bash.ts (trimming), the
redaction code in src/security/, src/config/sections/ barrel.

You own: src/mcp/**, src/tools/extra/{mcp,web_fetch,web_search}.ts,
src/cli/commands/mcp.ts, src/config/sections/{mcp,web}.ts, docs/mcp.md, docs/web.md, tests.

Allowed dependencies: @modelcontextprotocol/sdk (optional, dynamic import),
@mozilla/readability + linkedom for web_fetch (record in DECISIONS.md).

W6 MCP:
1. Config [mcp.servers.<name>]: command, args, env (map of env-var NAMES to forward, not values),
   or url + headers_env; allow_tools (glob list, default all); timeout.
   Also read the repo's .mcp.json (Claude Code format) and merge (config wins).
2. Client manager: start stdio servers lazily, connect HTTP servers, list tools, cache the list
   per run, restart a crashed server once, shut all down on run end.
3. Expose tools as mcp__<server>__<tool>, names sorted, JSON schemas normalised and key-sorted
   (reuse sortKeys). If more than 20 MCP tools total, expose a single `mcp_search(query)` tool
   that returns matching tool specs, plus `mcp_call(name, args)`, to keep the prompt prefix small.
4. Results: text content trimmed to 8k tokens, images dropped unless vision, everything redacted.
5. CLI: omnexx mcp add <name> -- <command...> | --url, mcp list, mcp remove, mcp test <name>.
W7 web:
6. web_fetch({url, maxTokens?}): GET with 15 s timeout, 5 MB cap, robots.txt honoured,
   HTML → readability → markdown, cached per run by URL. Host allowlist from [web] allow
   (default "*" for fetch) and deny list.
7. web_search({query, n?}): backends brave | tavily | searxng | exa chosen by [web] search =
   "<backend>" with key from env name; not registered when unconfigured.
Acceptance: an in-repo fake MCP server (stdio) passes list/call/crash-restart tests; >20 tools
switches to search mode; web_fetch and web_search tests use recorded HTTP fixtures only.
```

## Grok: W12 worker adapters and W14 safety

```
[paste shared preamble]

Workstreams W12 + W14. Branch: ws/12-workers-safety.

Read first: src/workers/{types,lifecycle,quota}.ts, docs/workers.md, docs/PLAN.md §15,
src/security/**, docs/safety.md, src/git/*.ts.

You own: src/workers/adapters/**, src/security/secret-scan.ts, src/security/policy-extra.ts,
docs/workers.md, docs/safety.md, tests.

W12:
1. Implement WorkerBackend adapters for: claude-code (`claude -p --output-format stream-json`),
   codex (`codex exec --json`), opencode (`opencode run`), aider (`aider --yes --message`),
   gemini-cli (`gemini -p`), qwen-code (`qwen -p`), cline CLI if a headless mode exists
   (else document as unsupported). Each: detect binary + version, minimum-version gate,
   build argv (never via a shell string), run in the per-attempt worktree from lifecycle.ts,
   enforce timeout by killing the whole process group, collect the diff, map exit codes and
   quota errors to the quota.ts types, and never read or log the tool's credentials.
2. Contract tests per adapter against a fake CLI script that replays recorded stdout
   (test/fixtures/workers/<name>/). Check: timeout kills the tree, quota error rotates to the
   next worker, push is disabled via GIT_CONFIG overrides, refs untouched after the run.
W14:
3. Secret scanner on every candidate commit: regexes for common key formats + entropy check on
   added lines; a hit returns a typed rejection reason (leave an INTEGRATION note for the
   verify path). Allowlist via [security] secret_allow = ["path-glob"].
4. Extend the command policy with rules for new tools: browser eval off by default, MCP tools
   tagged destructive need policy approval, workers always in a worktree.
5. Update docs/safety.md threat model for browser, MCP, web, workers.
Acceptance: PLAN §M3 worker criteria; secret scanner catches 20 seeded secrets with 0 false
positives on the repo itself.
```

## Ollama: W13 bench scaffolding and W15 docs

```
[paste shared preamble]

Workstreams W13 (scaffolding only) + W15 (docs only). Branch: ws/13-bench-docs.
You never touch src/. Keep each change small and run `npm run check` often.

Read first: docs/PLAN.md §4.7 and §M4, README.md, docs/config.md, docs/TODO.md §0.

You own: bench/**, README.md, docs/quickstart.md, docs/providers-guide.md, docs/why-omnexx.md,
.vhs/demo.tape.

W13:
1. bench/ as a separate TypeScript folder with its own tsconfig included in lint/typecheck.
   bench/run.ts: CLI `npm run bench -- --suite <name> --agents <a,b> --out bench/results/<date>`.
   Agent runners as small modules: omnexx (spawns `node dist/cli.js run --detach` and polls
   `status --json`), claude-code (`claude -p`), codex (`codex exec`). Each returns
   {resolved, usd, tokens_in, tokens_out, cached, wall_ms, interventions}.
2. Suites: jimmy10 (a folder of 10 task dirs, each with repo setup script, goal.md, and a hidden
   check command; create 3 example tasks now, leave 7 as TODO stubs), lite50 (loader stub that
   reads a JSON list of SWE-bench Lite instance ids; do not download anything in tests).
3. results writer: markdown table + raw JSONL. Unit tests with fake runners.
W15:
4. README rewrite: brand ASCII banner (copy from src/cli/brand.ts), one-line pitch, the
   "why omnexx over claude code" table from docs/TODO.md §0, quickstart in 3 commands
   (npm i -g omnexx; omnexx providers add; omnexx), a "how it works" list (gates, commits,
   rollback, fresh context, Nimble router), links to docs. No benchmark claims.
5. docs/quickstart.md, docs/providers-guide.md (OpenRouter, Groq, Ollama, LM Studio,
   custom gateway examples using [providers.endpoints.<name>] and `omnexx providers add`),
   docs/why-omnexx.md.
6. .vhs/demo.tape (charmbracelet vhs script) recording `omnexx --help` and a short run.
Acceptance: `npm run check` green; bench unit tests pass with fake runners; README renders.
```
