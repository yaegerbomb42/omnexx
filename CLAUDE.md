# omnexx

Long-running autonomous coding agent CLI (TypeScript, Node ≥ 22).

- **Start every session by reading [docs/NEXT.md](docs/NEXT.md)**: what's waiting on the owner,
  the agent's queue in order, and rules learned the hard way. [docs/TODO.md](docs/TODO.md) has
  the status table and session log; append a session entry when you finish.
- **Deployment & Infrastructure (Hub & VPS Architecture)**: See **[docs/DEPLOYMENT_AND_INFRA.md](docs/DEPLOYMENT_AND_INFRA.md)**.
  - **Frontend**: The public landing site lives on **GitHub Pages** (`https://yaegerbomb42.github.io/omnexx/` and `https://omnexx.org` port 8116). Deployed via `./deploy.sh omnexx --pages` from `yaegerbomb42/infra`.
  - **Backend**: Long-running agent daemons, background supervisors, and containers live on the **Oracle VPS (`147.224.158.118`)**.
  - **Never deploy static frontend landing pages to the VPS**. Central deployment orchestration lives in `yaegerbomb42/infra`.
- The only long-lived branch is `main` (`next` was retired on 2026-10-11). Branch from it, open
  PRs into it, and merge only after CI is green.
- Before committing: `npm run lint`, `npm run typecheck`, `npm run format:check` and
  `npm run test:quick` (all 780 unit tests, ~10s, plus the integration tests that touch files
  changed since `origin/main`). Don't run a bare `npx vitest run` locally: it also starts the
  chaos and e2e suites (30- and 10-minute timeouts). CI runs the full `npm test` on every PR (Ubuntu,
  Node 24) and on every OS/Node pair for `main` and releases; nothing merges until CI is green.
