# WHY.md — Omnexx Institutional Knowledge & Narrative Coherence (Mythos Core)

## 1. Overall Project Goals & Mission

**Omnexx** is a long-running autonomous coding agent CLI and VS Code extension built with TypeScript for Node ≥ 22.

- **Core Value Proposition**: "Set a goal, walk away, come back to commits." Omnexx executes multi-hour unattended coding runs against real repositories, verifying every change through tests, typechecks, and linters, and rolling back failures.
- **Model Agnostic & Cost-Conscious**: Built to run seamlessly across any LLM provider, including local free models (Ollama) with prompt caching optimization.

## 2. Architecture Overview & Critical Subsystems

- **CLI Core (`src/`)**: Autonomous loop orchestrating task decomposition, tool invocation, test verification, and automated git commits/rollbacks.
- **VS Code Extension (`vscode/`)**: Side panel interface providing real-time stats, step timelines, chat interaction, and model selection.
- **Deployment & Infrastructure (Hub & VPS Architecture)**:
  - **Frontend / Landing Site**: Hosted on GitHub Pages (`https://yaegerbomb42.github.io/omnexx/` and `https://omnexx.org` port 8116). Deployed via `./deploy.sh omnexx --pages` from central `yaegerbomb42/infra`.
  - **Backend**: Long-running background agent daemons and supervisors run on the Oracle VPS (`147.224.158.118`).
  - **Separation of Concerns**: Static frontend assets are never deployed directly to the VPS.
- **Benchmarks & Harness (`bench/`)**: Comparative benchmarks tracking autonomous agent task completion rates, prompt cache hits, and token costs.

## 3. Key Decisions & Hard-Learned Lessons

- **Branching Strategy**: The only long-lived branch is `main` (`next` branch retired as of 2026-10-11). Work is done via feature branches and merged to `main` only when CI is clean.
- **Quality Gates**: Every kept step must pass strict validation (`lint`, `typecheck`, `format:check`, `test:quick`). Bare vitest runs locally are avoided to prevent triggering slow chaos/e2e suites.
- **Atomic Rollbacks**: Any modification failing verification is immediately reverted to preserve clean git state.

## 4. Current Priorities & Active Constraints

- Node version requirement: Node ≥ 22.
- Primary roadmap items tracked in [docs/NEXT.md](file:///Users/yaeger/Desktop/omnexx/docs/NEXT.md) and [docs/TODO.md](file:///Users/yaeger/Desktop/omnexx/docs/TODO.md).
- Zero-secret policy: sensitive keys must always remain in environment variables.

## 5. Session History & Log

- **2026-10-28 (Session Init)**: Cloned `yaegerbomb42/omnexx` repository into `/Users/yaeger/Desktop/omnexx`. Initialized `WHY.md` institutional knowledge base. Working tree is clean on `origin/main`.
<<<<<<< HEAD
- **2026-10-28 (Release v0.21.1 / Extension 0.17.1)**:
  - Prepared release for VS Code Marketplace overhaul: bumped root `package.json` to `0.21.1` and `vscode/package.json` to `0.17.1`.
  - Replaced low-quality cropped snippet screenshot with high-fidelity visual assets ([`panel.png`](file:///Users/yaeger/Desktop/omnexx/vscode/media/panel.png), [`model-picker.png`](file:///Users/yaeger/Desktop/omnexx/vscode/media/model-picker.png), and [`demo.gif`](file:///Users/yaeger/Desktop/omnexx/vscode/media/demo.gif)).
  - Streamlined [vscode/README.md](file:///Users/yaeger/Desktop/omnexx/vscode/README.md) with 3-step quickstart and mode comparison matrix.
  - Updated marketplace descriptor in [vscode/package.json](file:///Users/yaeger/Desktop/omnexx/vscode/package.json).
  - Resolved duplicate assignment in `src/cli/program.ts` and duplicate import in `src/core/supervisor.ts`.
  - Updated [CHANGELOG.md](file:///Users/yaeger/Desktop/omnexx/CHANGELOG.md).
  - All unit tests, typechecks, ESLint, and Prettier checks passing.
=======
>>>>>>> origin/feat/subagent-research-sandbox
- **2026-10-28 (Task 1: Prompt Cache Pinning & Dynamic State Quarantine)**:
  - Enforced `pinPrefix(req.system)` in Anthropic wire payload generation (`src/providers/anthropic.ts`).
  - Placed ephemeral dynamic session state (`ctx.volatilePrompt`) at the user prompt suffix.
  - Verified stable blocks come first with `cacheBreakpoint` exclusively on the last stable block before volatile blocks. PR #357.
- **2026-10-28 (Task 2: AST & Symbol-Level Outline Reader)**:
  - Extended symbol extraction in `src/tools/outline.ts` to compute exact line spans (`lines X-Y`) using bracket/indent matchers (`findBraceEndLine`, `findPythonEndLine`).
  - Added support for top-level `const fn = () =>` / `const fn = function` arrow/anonymous function declarations.
  - Formatted outline output as `kind name (lines X-Y)`. PR #360.
- **2026-10-28 (Task 3: Tool Output Compactor & Error-Trace Reducer)**:
- **2026-10-28 (Task 3: Tool Output Compactor & Error-Trace Reducer)**:
  - Enhanced `src/tools/output-compress.ts` to fold high-volume package manager noise (npm deprecation warnings, audit notices, funding prompts) and build tickers (vite module transformation lines) into clean single-line summaries while guaranteeing that error lines and failure traces are never suppressed.
  - Stripped git tutorial advice (`use "git add..."`) from command output to free up LLM context space.
  - Collapsed excessive blank lines.
  - Added unit test suite in `test/unit/tools/output-compress.test.ts` verifying >50-80% line reduction on noisy failing test runs with 100% assertion and project stack frame retention. PR #367.
- **2026-10-28 (Task 4: Isolated Subagent Research Sandbox)**:
  - Hardened read-only subagent tool constraints and context boundary: subagents can consume large context (up to 50k tokens) exploring code and reading web/docs, but hand back only a tightly bounded, synthesized executive summary (capped at 1,500 chars / ~350 tokens) with key file:line anchors (at most 8 deduplicated paths) to the orchestrator.
  - Added strict tool denial (`safeSubagentTools`) stripping modifying and execution tools (`bash`, `write_file`, `str_replace`, `apply_patch`, `patch`, `task`, `todo`).
  - Consolidated `formatSubagentResult` into a single canonical implementation in `src/agent/subagent.ts` used across `task` and `agent` tools.
  - Added unit test suite in `test/unit/agent/subagent-isolation.test.ts` verifying tool denial, result truncation, file deduplication, out-of-band artifact emission, and `taskTool` execution. PR #368.
