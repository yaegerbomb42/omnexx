# Build log

Read this first after a compaction or restart, together with the handoff (`~/Desktop/omnexx-claude-handoff.md`) and the current `docs/milestones/M<n>.md`.

## Current milestone

M0 (skeleton).

## Checklist (handoff §8)

- [x] Cloned to `~/Projects/omnexx`, branch `feat/m0-m2-core`, `docs/PLAN.md` copied and committed
- [x] `docs/DECISIONS.md` started with the deliberate deviations
- [ ] M0 done, pushed, draft PR open, CI green on all 4 cells
- [ ] M1 done, pushed, CI green
- [ ] M2 done (incl. hierarchical plan, codemap, checkpoints, report, wrap-up reserve, 24 h budgets, WorkerBackend + lifecycle + fake worker), pushed, CI green
- [ ] Docs written, README honest, no comparative claims
- [ ] `docs/REPORT-M0-M2.md` written, PR body updated, PR ready (not merged), report copied to Desktop
- [ ] Landing page built and tested in `~/Desktop/infra/infra/apps/omnexx/`
- [ ] Three infra config edits made, diffs captured
- [ ] Nothing published, nothing pushed to `main`, `~/omnexx-npm` untouched, nothing committed in infra, `deploy.sh` not run

## Log

- 2026-10-03: cloned, branched, plan copied. Toolchain installed (TS 6.0.3, see D2). Pricing checked (D3).
- 2026-10-03 (late): plan revised (personal use, §14/§15). New PLAN.md committed. Schema adapted (D4). M2 scope grew; workers = interface + lifecycle + fake only.

## Notes for future me

- In this shell `grep` is a broken function that prints a Claude Code install error. Use `/usr/bin/grep` or `rg`. Prefer node for scripted edits.

- npm's default cache at `/tmp/npm-cache-swarm` has a permission problem; use `--cache /tmp/omnexx-npm-cache` for installs.
- `npx changeset init` hangs; `.changeset/config.json` was written by hand.
