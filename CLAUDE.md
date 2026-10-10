# omnexx

Long-running autonomous coding agent CLI (TypeScript, Node ≥ 22).

- **Start every session by reading [docs/NEXT.md](docs/NEXT.md)**: what's waiting on the owner,
  the agent's queue in order, and rules learned the hard way. [docs/TODO.md](docs/TODO.md) has
  the status table and session log; append a session entry when you finish.
- Integration branch is `next`. Branch from it, open PRs into it, and merge only after CI is
  green.
- Before committing: `npm run lint`, `npm run typecheck`, `npx vitest run` (and `npm run
format:check`).
