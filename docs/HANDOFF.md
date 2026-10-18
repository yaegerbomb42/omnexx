# Handoff (2026-10-17)

Where omnexx stands, what is left, and where it is going. Read this first, then
[NEXT.md](NEXT.md) (queue and hard-won rules) and the session log in [TODO.md](TODO.md).

## 1. What omnexx is

A long-running autonomous coding agent CLI (TypeScript, Node ≥ 22) built to beat Cline and
Claude Code on real tasks with fewer tokens, and to keep working for hours or days on an open
goal ("improve the codebase"). Surfaces: the `omnexx` CLI/TUI, a VS Code extension (`vscode/`)
that bundles the CLI, and a chat server the panel drives.

Core loop: plan → cycles (think, act with tools, gates: related tests then the full suite,
review, commit) → beyond mode (evidence-ranked improvement rounds) → report. Context is kept
small by pruning, clearing, folding into a working state and digests
([architecture.md](architecture.md)).

## 2. Current state

| Item                 | State                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| `main`               | `a6d843b`, green CI; the only long-lived branch                               |
| npm                  | `omnexx@0.18.2`; **49 commits on `main` are unreleased** (#183–#230)          |
| VS Code / Open VSX   | `yaegerbomb42.omnexx` 0.14.2 published; panel redesign (#218–#225) unreleased |
| Homebrew / curl      | tap `yaegerbomb42/homebrew-omnexx`; `omnexx.org/install.sh`                   |
| Open PRs (this repo) | none                                                                          |
| Listing PRs          | ollama/ollama#18959 open; EndoTheDev/Awesome-Ollama#113 closed                |
| Master TODO          | all 20 items shipped ([MASTER-TODO.md](MASTER-TODO.md))                       |
| Tests                | ~1,340 unit+integration in `test:quick`; CI runs the full suite               |

**Bench (2026-10-16, hard10, DeepSeek V4.1 Flash, 1 rep):** omnexx resolved 9/10 with 616k
fresh input tokens; Cline 6/11 with 1.32M. Data: `bench/results/full-2/`.

**Where omnexx's fresh tokens went:** 44% new content, 32% provider-side cache misses, 10%
cold starts, 7% re-reads after compaction, 7% side calls (review, codemap). Fixes since that
bench (unmeasured): #226 reruns supersede older output, #227 miss-aware fold thresholds,
#228 review actually hits the worker cache, #229 `lazy_tools` (off by default).

### Shipped in the last two sessions

- **Efficiency (master todo 1–20):** multi-file reads, bookkeeping out of the loop, related
  tests first, hung-call cutoffs, bench efficiency columns, cache-miss detector and
  `prompt_cache_key`, first-call budget, `outline` for directories, test-output digests,
  right-sized think phase, conditional tools, self-correcting denials, repo probe, `str_replace`
  recovery, token calibration, doctor reports, evidence-ranked backlog (`core/evidence.ts`).
- **Security:** `web_fetch` refuses private/metadata addresses on every redirect (#216);
  redactor covers Stripe and HuggingFace keys.
- **VS Code panel:** native title-bar actions and workbench tokens, composer with mode pills,
  model chip, context meter and usage popover, tool glyph rows, copy/edit-resend/history,
  approval keys, `@` file mentions, `/` commands, drag-and-drop, Send ⇄ Stop.

## 3. Waiting on the owner

- [ ] **Release 0.19.0** + extension 0.15.0 (tag pushed; needs npm 2FA on the staged publish).
- [ ] **Approve a bench** to measure #227/#228 and decide on `lazy_tools` (command in §4.1).
- [ ] Replace the Azure DevOps and Open VSX tokens (they were pasted into a chat).
- [ ] Review the new VS Code panel in a real window and report problems.
- [ ] Live-test `omnexx connect notion|email`, `omnexx --ollama`, a long `run --for 8h`.
- [ ] Optional: PyPI account (pip/uvx), Apple developer account (signed binary).

## 4. What's left, in order

1. **Measure.** `set -a; . ~/.omnexx-bench.env; set +a; npm run bench -- --suite jimmy10
--agents omnexx,cline,openhands --endpoint DEEPSEEK`, 3 reps per task, run _without_ other
   load (134 rate-limit 429s skewed the last run). Then a second pass with
   `[context] lazy_tools = true`; turn it on by default only if pass rate holds and fresh tokens
   drop. Finish the judge row (Nimble steer vs off).
2. **Release** 0.19.0 / extension 0.15.0 after the bench, with the README numbers refreshed.
3. **Release automation:** publish the extension from CI (`VSCE_PAT`, `OVSX_PAT` secrets) and
   update the Homebrew tap from `release.yml` after npm approval.
4. **Evidence backlog phases 2–3** (beyond mode): stop on diminishing returns (rounds whose
   accepted diffs shrink or whose evidence repeats), and per-item acceptance checks written
   before the round starts.
5. **Context, next layer** (see §5): cross-cycle state diffing, cheap-model routing for
   bookkeeping turns, output-token budget for think blocks.
6. **Connector gaps:** Asana and Square (DCR only on deprecated SSE); Box, HubSpot remote,
   Asana v2 (no DCR); Salesforce, Zoom (no free path); `google` needs the user's own client.
7. **Standalone binary** (bun compile or node SEA; darwin/linux/win x64+arm64) for Node-less
   installs and PyPI wheels (~1–2 days).
8. **Older backlog:** W13 bench docs (`ws/13-bench-docs`), audit the W1/W2/W3/W9 checkboxes,
   SonarCloud findings from #20, 20 duplicate CSS selectors in `vscode/media/chat.css`, the CLM
   context mode.
9. **Housekeeping:** ~35 remote branches were squash-merged and are stale
   (`git branch -r --no-merged` lists them because of squash); worktrees `omnexx-wt-b0`,
   `omnexx-wt-conditional-tools` (its one commit is already in `main` as #213) and
   `omnexx-wt-spark` (holds `main`, blocks `gh pr merge` from switching to it locally) belong to
   stopped agents. Delete only with the owner's OK.

## 5. Future goals

- **Days-long autonomy from a one-line goal.** A 24 h soak (`run --for 24h` on a real repo)
  with a green report: no stalls, no doom loops, budget respected, every commit gated. The
  evidence backlog is the engine; diminishing-returns stop and acceptance checks are the brakes.
- **Win the head-to-head on every task**, stable over 3 reps: pass rate ≥ Cline and Claude
  Code, fresh tokens ≤ 50% of Cline's, wall time ≤ theirs.
- **Context management "perfect" means:** the cached prefix never changes within a run
  (verified by the cache-miss detector reporting only provider-side misses), a fold never loses
  a decision or a failed approach (the working state carries them), and the cost of a miss is
  bounded by keeping the prompt near the miss-aware threshold. Open ideas, measured first:
  - diff-only state between cycles (send what changed, not the whole state block);
  - route bookkeeping and summaries to the cheap chain on the same provider (shared cache);
  - cap think-block output per turn (output was 116k of the bench's tokens);
  - independent reviewer model plus mutation testing to keep the pass rate honest.
- **Distribution:** CI-published releases everywhere (npm, Marketplace, Open VSX, Homebrew,
  PyPI wheels, standalone binaries), awesome-list listings once the repo has 25 stars.

## 6. How to work here

- Start with `docs/NEXT.md`; append a session entry to `docs/TODO.md` when you finish.
- One PR per change into `main`; squash-merge with `--delete-branch` only after CI is green.
  Check the result of `gh pr checks --watch` before merging, never chain them.
- Before committing: `npm run lint`, `npm run typecheck`, `npm run format:check`,
  `npm run test:quick`. Never a bare `npx vitest run` (it starts the chaos and e2e suites).
- No `eslint-disable`, `.skip`/`.only`, weakened tests or silent catches. Tests never touch
  real services. Never a bare `git merge` (use `git -c core.attributesFile=/dev/null merge`).
- Known flakes under load: `test/integration/process.test.ts`, `test/unit/tui/ranking.test.ts`,
  Docker sandbox tests. Rerun in isolation before assuming a regression.
- Publishing (npm, extension, Homebrew, PRs to other repos) and live benches need the owner's
  explicit yes each time.
- VS Code webview UI: preview with the stubbed harness (extract the HTML from `chatView.ts`,
  stub `acquireVsCodeApi`, serve `vscode/` on localhost); webview DOM files go in the root
  `tsconfig.json` exclude list.
