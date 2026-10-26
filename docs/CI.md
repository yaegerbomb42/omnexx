# CI lanes

| Lane   | Trigger                         | Runs                                                                                                                 | Target               |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `fast` | push to `experimental/**`       | typecheck + `vitest --changed origin/main` (unit + integration)                                                      | < 2 min              |
| `pr`   | every pull request              | format, lint, typecheck, **affected** tests (`--changed origin/<base>`, all projects incl. chaos), build, pack smoke | ~3–4 min             |
| `full` | push to `main`, nightly, manual | whole suite sharded 4 ways × {ubuntu, macos} × {node 22, 24}; static + package smoke per platform; one coverage job  | wall ≈ slowest shard |

PRs wait only on `pr` (plus SonarCloud). The full suite never blocks a PR; a break it catches
on `main` is fixed forward. Locally: `npm run test:affected`, or `npm run test:related -- <files>`.

vitest's `--changed` falls back to the full suite when config or lockfiles change, so CI-config
PRs still get the whole run.

## Slowest tests (local run, 1,994 tests, Oct 2026)

| Time       | Test                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 103 s file | `test/unit/bench/web5.test.ts` — task-02 mobile overflow 61 s, task-05 console errors 40 s (real browser) |
| 62 s file  | `test/chaos/chaos.test.ts` — 20 seeds × ~3 s, "finishes with 30 commits" 9 s                              |
| 40 s file  | `test/unit/tools/browser-check.test.ts` — overflow 20 s, broken images 20 s                               |
| 30 s file  | `test/integration/supervisor.test.ts` — stuck-task split 6 s, impossible-task 4 s                         |
| 21 s       | `test/integration/bench-hard10.test.ts` — hidden checks fail/pass with reference                          |
| 14 s file  | `test/integration/fast-path.test.ts`                                                                      |
| 9 s file   | `test/integration/process.test.ts` — detach/pause/resume 6 s                                              |

## Prune / move candidates (nothing deleted)

1. `web5.test.ts` and `browser-check.test.ts` spawn a real browser but live in the **unit**
   project: move them to `integration` (or a `browser` project) so unit stays sub-second per file.
2. `bench-hard10` / `web5` reference-solution checks validate bench fixtures, not product code:
   run them only when `bench/**` changes and nightly.
3. Chaos: PRs use `OMNEXX_CHAOS_ITERATIONS=20`; 5 would keep coverage of every fault type
   at a quarter of the cost, with 200 nightly unchanged.
4. `browser.test.ts` "20 open/close cycles" — 5 cycles would still catch orphan leaks.
