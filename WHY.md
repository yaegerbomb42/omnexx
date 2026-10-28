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
- **2026-10-28 (Release v0.21.1 / Extension 0.17.1)**:
  - Prepared release for VS Code Marketplace overhaul: bumped root `package.json` to `0.21.1` and `vscode/package.json` to `0.17.1`.
  - Replaced low-quality cropped snippet screenshot with high-fidelity visual assets ([`panel.png`](file:///Users/yaeger/Desktop/omnexx/vscode/media/panel.png), [`model-picker.png`](file:///Users/yaeger/Desktop/omnexx/vscode/media/model-picker.png), and [`demo.gif`](file:///Users/yaeger/Desktop/omnexx/vscode/media/demo.gif)).
  - Streamlined [vscode/README.md](file:///Users/yaeger/Desktop/omnexx/vscode/README.md) with 3-step quickstart and mode comparison matrix.
  - Updated marketplace descriptor in [vscode/package.json](file:///Users/yaeger/Desktop/omnexx/vscode/package.json).
  - Resolved duplicate assignment in `src/cli/program.ts` and duplicate import in `src/core/supervisor.ts`.
  - Updated [CHANGELOG.md](file:///Users/yaeger/Desktop/omnexx/CHANGELOG.md).
  - All unit tests, typechecks, ESLint, and Prettier checks passing.
- **2026-10-28 (Task 6: Anti-Doom-Loop Ratchet & 2-Strike Rollback)**:
  - Implemented `DoomLoopRatchet` in `src/core/doom-loop-ratchet.ts` to break recurring agent failure cycles.
  - Implemented rolling hash deduplication of tool errors (`normalizeErrorSignature` & `hashErrorSignature`): identical tool failures twice in a row trigger execution interception with a strategy shift prompt (`Strategy failed twice with error: ... Roll back the file and propose an alternative strategy.`).
  - Implemented the "Zero Partial Work" rollback ratchet on verification failures: when test/verification commands fail on dirty files, exactly 1 targeted fix turn is allowed. If verification fails a second time, modified files are immediately and atomically rolled back via git to the clean baseline state, preventing edit spirals.
  - Integrated into `src/agent/loop.ts` and `src/core/cycle.ts`. Added unit test suite in `test/unit/core/doom-loop-ratchet.test.ts`.

