# omnexx

Long-running autonomous coding agent CLI (TypeScript, Node ≥ 22).

- **Start every session by reading [docs/NEXT.md](docs/NEXT.md)**: what's waiting on the owner,
  the agent's queue in order, and rules learned the hard way. [docs/TODO.md](docs/TODO.md) has
  the status table and session log; append a session entry when you finish.
- The only long-lived branch is `main` (`next` was retired on 2026-10-11). Branch from it, open
  PRs into it, and merge only after CI is green.
- Before committing: `npm run lint`, `npm run typecheck`, `npm run format:check` and
  `npm run test:quick` (all 780 unit tests, ~10s, plus the integration tests that touch files
  changed since `origin/main`). Don't run a bare `npx vitest run` locally: it also starts the
  chaos and e2e suites (30- and 10-minute timeouts). CI runs the full `npm test` on every PR, and
  nothing merges until CI is green; that's the full check.
