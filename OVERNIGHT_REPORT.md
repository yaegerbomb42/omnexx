# Overnight report — make Omnexx simple, working, and as good as Cline

Branch: `overnight/radify-20261026` (base: main @ `b761e8d`). One PR at the end; no merge to main, no force-push.
Status: COMPLETE except the PR — all 4 phases merged and verified, 3 E2E tasks done live, full suite run once. Push + PR pending GitHub write approval (user asleep; see Blockers).

## Status log

- 00:18 CDT — Fresh clone at `~/workspace/omnexx-overnight`, tip `b761e8d` (main has moved past `a72ca10`; includes v0.21.0 release), `npm ci` clean (534 packages). Branch created. Four phase worktrees spun up (p1 run, p23 modes+settings, p4 UI, p5 memory), each on its own phase branch.
- 00:22 CDT — PROVIDER UPDATE: live Inception endpoint available (https://api.inceptionlabs.ai/v1, OpenAI-compatible, model mercury-3). Endpoint verified live, key 1 works. E2E runs use live mercury-3, not a stub. Keys are env-var only, never written anywhere.
- 00:24 CDT — User pre-approves ALL mission actions including webpage checks; asleep overnight, no approval prompts. Standing limits hold: no merge to main, no force-push, no key printing/storing, mission branch only. Watch cron `omnexx-fixes-watch` checks progress every 35 min.
- ~00:30 CDT — BLOCKER: GitHub writes blocked overnight — `create_branch` via the connector needs interactive confirmation; user asleep, confirmation timed out (30 min) and the service restarted mid-call twice. Remote branch does NOT exist yet (verified 404). All work stays LOCAL tonight; pushes + PR open in the morning when the user can approve.
- ~03:00 CDT — Update: a `create_branch` approval card IS now pending for the user (requested 2026-10-26T07:58:50Z). Once he approves it in the morning, push the branch contents via `push-files` (needs its own approval card) and open the PR (base: main). All mission work is complete locally; nothing else is blocked. The orphan-fix crew has two `push_files` cards pending for `fix/orphan-processes` too.
- ~01:10 CDT — All 4 phase agents DONE (commits on their phase branches, nothing pushed). Merged into `overnight/radify-20261026` with ZERO conflicts. Typecheck green on the merged branch. `--help` verified: 8 commands default, 25 with `--experimental`. `test:quick` running on the merged branch; E2E verification agent running the 3 real tasks live.

## Does it run? YES (live, verified twice by Phase 1)

- Fresh install: `npm i -g .` → `omnexx init -y` → `omnexx run "add a hello() function to utils.ts and a test for it"` — **FINISHED** 9/9 tasks, 4/4 milestones, 8 commits, wall 4m19s, exit 0, process exits on its own ~1s after finish. Provider: live Inception mercury-3. Tokens: **442,395 total** (129,083 uncached + 286,214 cache-read + 27,098 output), 75 model calls / 57 turns. Verified by hand: `utils.ts` has `hello()`, `npm run test` 7/7 pass.
- 3 startup crashes fixed (Phase 1): (1) `providers add --key-env` silently dropped on the smart path — endpoint saved keyless, first real call 401'd; (2) anti-cheat false-positive on `node_modules` markers in repos with no `.gitignore` (rollback loop); (3) foreground `omnexx run` never exited after finish — shell sessions never disposed.

## Modes and settings (before → after)

|                                           | Before                                                                                                                                        | After                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible commands in `omnexx --help`       | 25                                                                                                                                            | **8** (run, watch, status, logs, plan, init, doctor, auth; 25 with `--experimental`)                                                            |
| Options in `run --help`                   | 19                                                                                                                                            | **7** (19 with `--experimental`)                                                                                                                |
| Modes visible in default UI/help          | work domain swe/general, posture efficient/normal/extreme, plan auto/fast/full, kind auto/code/writing, sandbox host/docker, push none/branch | **1 default mode** (plan, edit, verify); all others behind `experimental` (`--experimental`, `OMNEXX_EXPERIMENTAL=1`, or `experimental = true`) |
| User config files                         | 3 (config.toml, roles.json, models.json)                                                                                                      | **1** (config.toml, with `[pool]` + `[roles]` tables)                                                                                           |
| User-facing settings documented           | dozens across 3 files                                                                                                                         | **~10 essentials**                                                                                                                              |
| VS Code settings sections open by default | 8 of 11                                                                                                                                       | **5** (Agent, Chat model, Your models, Providers, Approvals); rest folded under Advanced                                                        |

- First run asks 2 things only: provider + key (or detects existing keys/env), then model. Key goes to a 0600 file, never config.toml.
- Migration: tested against a fixture of 9 providers with 2-key rotation lists — all preserved in order, pool/roles landed in config.toml, legacy files renamed to `*.migrated`, hand-written comments survived.
- Not deleted: hidden commands/modes still parse and run when invoked.

## UI (before → after)

- VS Code panel: footer was 6 scattered chips; now one quiet status line above the input — `model ▾ · 12.4k tok · step 3/8` + context meter as inspector button. Single Stop button (send morphs to Stop while busy; Esc also stops; separate pause button removed from footer). One accent color: tool badges lost per-kind rainbow, cache pill's hardcoded cyan removed. CLI: new `FeedLines` collapser — tool bursts collapse to one summary line at default verbosity; `route.decision`, `cache.miss`, `autonomous.idle` demoted to verbose. VSIX builds clean (1.86 MB).
- NOT done: inline diffs with Approve/Reject per edit. The data doesn't exist in the panel pipeline (server forwards only narrated one-line `act` entries; edits apply without asking). It's a cross-layer feature, not UI polish — needs its own phase with server-side work.
- No screenshot possible in this VM (no VS Code GUI) — text captures in the PR body instead.

## Rolling memory

- Every 7 turns the loop rewrites working memory into a compact note (≤6,000 chars, ~1,500 tokens) with all six sections: Current goal; Active work (newest first, full detail); Decisions and why; Facts (file path + sha256); Open threads (one line each, fading with age); Failed attempts (don't retry). Newest 3 work items stay detailed; older ones demote to one-line threads; nothing dropped silently (covered turn range stated; overflow collapses into an explicit counted line). Raw transcript stays on disk in `logs/transcript.md` (redacted); `recall(query)` tool pulls old details back (transcript files get a 1M-char cap). Prompt = system + memory note + working set + last 2 turns raw. Default on in the main mode; `memory: rolling | full` setting. Note shows in the VS Code panel as a collapsible "What I remember" section.
- Prompt-size-per-turn (40-turn simulation, ~3k chars tool output/turn): rolling mean turns 10–19 = **6,312** tokens, mean turns 31–40 = **6,838 (+8.3%)**, max 9,674; raw-history baseline turn 40 = **43,792** (grows ~4×). Rolling stays flat — a sawtooth between condensations, not a staircase.

## 3 real E2E tasks (live mercury-3, merged branch `cc27cc5`)

All 3 goals met; all runs used default mode, `--budget 2 --hours 0.5`, model via `OMNEXX_MODELS_*=inception:mercury-3` env vars. Tokens are the honest cost metric — $0.00 everywhere is not a real signal (mercury-3 is unpriced in omnexx's pricing table). Work lands on run branches (`omnexx/r_<id>`) in `~/.omnexx/worktrees/`; the checkout is untouched until merged.

| #   | Task                                   | Result                                       | Tokens                        | Time  |
| --- | -------------------------------------- | -------------------------------------------- | ----------------------------- | ----- |
| 1   | Small bugfix (off-by-one)              | **FINISHED**, exit 0                         | 475,417 (60 calls / 53 turns) | 8m09s |
| 2   | New function + test (`capitalize`)     | **GOAL DONE, run ended needs-human**, exit 2 | 601,337 (88 calls / 82 turns) | 3m21s |
| 3   | 3-file refactor (shared `validate.ts`) | **FINISHED**, exit 0                         | 293,436 (48 calls / 40 turns) | 1m47s |

- Verified independently on the run branches: task 1 `npm test` 12/12 pass, task 2 13/13 pass, task 3 12/12 pass with zero duplicated `validateName` remaining. Run records: `~/.omnexx/runs/r_20261026_0732_1442`, `r_20261026_0741_ad80`, `r_20261026_0744_72fb`.
- Task 2's exit 2 is a real supervisor-loop bug (verified in the run's events): docs task M4.T03 was completed and committed in cycle 8, then re-run in cycles 9–10, found "no changes", rejected twice, parked, and the run stopped (`stop_and_ask`, "nothing runnable: 1 parked node(s)"). Goal and all other work were done; the run died re-verifying an already-finished task. Also in task 2: Inception 500'd 3×; failover retried, stuck detector fired `poisoned_request`, and the task was then accepted in the same minute — the review turn that kept 500ing appears to have been skipped rather than retried.
- Cross-cutting: **every goal was met in 11–20s in cycle 1**. Everything after that was the CLI's default "beyond" behavior (3 improvement rounds: validation hardening, BigInt/grapheme handling, READMEs) — the dominant time/token cost in all 3 runs (~1.5–8 min vs ~15s for the goal). No obvious flag disables beyond rounds in `run --help`.
- No gates were configured in any test repo (no `omnexx.toml`); agents ran `npm test` themselves as task checks. The mission's gate story is untested by these runs.

## Test results (merged branch)

- Typecheck (root + webview): **clean**.
- `test:quick` unit: **1,805 passed / 6 failed / 4 skipped** (265 files). All 6 failures verified PRE-EXISTING by me — identical 6 tests fail on pristine main `b761e8d` in a scratch worktree (suites jimmy10 ×2, web5 ×3, tui/ranking picker timeout). Zero new failures from the mission.
- `test:quick` integration (`--changed` vs origin/main): **194 passed / 0 failed / 4 skipped** (50 files), rc=0.
- Full suite (`npm test`: unit + integration + chaos): **2,026 passed / 8 failed / 8 skipped** (318 files, 817s). The 8: bench-hard10 ×1, jimmy10 ×2, web5 ×3 (all 6 verified pre-existing on pristine main) + chaos SIGKILL seeds 5 and 11 (flaky — pass on re-run on BOTH the mission branch and main). Ranking picker test passed in the full run (timing-sensitive; failed in test:quick). Zero deterministic new failures.
- Phase branches reported: P5 unit 1,781 pass + integration 187 pass, 5 pre-existing bench failures; P2+3 `test:quick` 1,785 pass / 5 fail — all 5 pre-existing on main (3 bench/web5 + slow tui/ranking picker test).

## What's still broken

- Inline diffs with Approve/Reject per edit — not built (see UI above); needs a server-side phase.
- **Supervisor re-verifies finished tasks and can park the run (found by E2E task 2):** a completed task re-run in later cycles, "no changes", rejected, parked, run stops needs-human even though the goal is done. Fix: mark a task done-and-verified once, don't re-verify it in later cycles.
- Failed task checks don't block acceptance (observed by Phase 1, not changed — needs a design call): a `verify.result` of `verdict: "accept"` can carry failed checks; only gates/anti-cheat/review can reject when changes exist.
- Stuck-detection can accept a task whose review never completed (E2E task 2: Inception 500s → `poisoned_request` → task accepted the same minute).
- "Beyond" rounds dominate every run (goal met in ~15s, run takes 1.5–8 min) with no flag to disable them — needs a `--no-beyond` / budget-shaped default.
- Bare `omnexx init` in a non-git dir prints a usage error but exits 0 (minor). `omnexx run` has no top-level `--model` flag (model comes from `omnexx.toml` `[models]`).

## Stuck / skipped (45-min rule)

- GitHub writes blocked overnight (see Blockers) — pushes + PR deferred to morning.
- Phase 4 skipped inline diffs Approve/Reject (cross-layer feature, brief forbids new features).
- VM reset mid-mission (~06:00 UTC): `/tmp` wiped and the global install vanished; worktrees, `~/.omnexx`, `~/.config/omnexx` survived. Test repos moved to durable paths; don't rely on `/tmp` or the global install persisting.

## Top 3 next steps

1. **Fix the supervisor re-verification loop** (E2E task 2): don't re-verify finished tasks in later cycles; a parked finished task should not kill a completed run. This is the only E2E failure mode that hit a finished goal.
2. **Build inline diff Approve/Reject as its own phase** (server must emit old/new text + block on approval; protocol + webview render it). The panel work is done; the data pipeline is the missing piece.
3. **Give beyond rounds an off switch / budget shape**: goals land in ~15s but runs take minutes and 300–600k tokens on hardening rounds. A `--no-beyond` flag (or making beyond rounds opt-in) is the biggest token/time win available.
