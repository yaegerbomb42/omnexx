# Next steps (handoff)

Written 2026-10-09 at the end of a session. Start here. When an item is done, tick it, note
the PR, and append a session entry to the log in [TODO.md](TODO.md).

State (2026-10-17): see [HANDOFF.md](HANDOFF.md) for the full picture. npm has `omnexx@0.18.2`
and the extension 0.14.2; 49 commits on `main` (#183–#230) are unreleased. The release notes
below are from 2026-10-12 and kept for the channel details.

## Released (2026-10-12)

- npm: `omnexx@0.5.0` (trusted publishing; the publish lands in npm's staged queue and the owner
  approves it with 2FA on npmjs.com before it goes live).
- curl: `curl -fsSL https://omnexx.org/install.sh | sh` redirects to `scripts/install.sh` on `main`.
- Homebrew: `brew install yaegerbomb42/omnexx/omnexx` (tap repo `yaegerbomb42/homebrew-omnexx`;
  regenerate `Formula/omnexx.rb` with `scripts/brew-formula.sh <version>` after each release).
- VS Code Marketplace and Open VSX: `yaegerbomb42.omnexx` 0.1.0 (published by hand with the
  owner's tokens; moving that to CI with repo secrets is still open).
- Listing PRs, open: ollama/ollama#18959, EndoTheDev/Awesome-Ollama#113. awesome-llm-agents needs
  25 stars (its CI checks), so submit later as `data/frameworks/omnexx.yml`.

## Waiting on the owner

- [ ] Review the VS Code sidebar and report problems.
- [ ] Replace the Azure DevOps and Open VSX tokens (they were pasted into a chat).
- [ ] Live-test `omnexx connect notion|email`, `omnexx --ollama`, and a long `run --for 8h`.
- [ ] Optional, later: a PyPI account (for `pip`/`uvx`) and an Apple developer account.

## Agent's queue, in order

0. **Measure, then release** (2026-10-17; `feat/autonomy-2` shipped long ago, now at 0.18.2): see
   [HANDOFF.md](HANDOFF.md) §4. Rerun the head-to-head 3x per task (`npm run bench --
--suite jimmy10 --agents omnexx,cline,openhands --endpoint DEEPSEEK` after `set -a; . ~/.omnexx-bench.env; set +a`) for stable
   numbers, and finish the judge row (Nimble steer vs off; it hasn't changed results so far).
   Remaining gaps (2026-10-16 bench: omnexx 616k fresh tokens vs Cline 1.32M; bench `[context] lazy_tools` and #227/#228 next); 20 duplicate CSS selectors
   need a visual check; CLM context mode not started.

1. Watch the two listing PRs and answer review comments.
2. Release automation: publish the extension from CI with `VSCE_PAT` / `OVSX_PAT` secrets, and
   update the Homebrew tap from `release.yml` after npm approval.
3. **Connector follow-ups** (from live-test reports). Known gaps: Asana and Square (dynamic client
   registration only on deprecated SSE); Box, HubSpot remote, Asana v2 (no dynamic
   registration); Salesforce and Zoom (no free path); `google` connectors need the user's own
   Google client.
4. **Standalone binary** (for `pip`/`uvx` and Node-less installs; about 1-2 days): bun compile or
   node SEA for darwin/linux/win x64+arm64 on tags, used by `install.sh` when Node is missing,
   wrapped as per-platform PyPI wheels.
5. Older backlog (see TODO.md): W13 bench (`ws/13-bench-docs`), audits of the W1/W2/W3/W9 boxes,
   open SonarCloud findings from #20.

## Rules learned this session

- PRs go into `main` (the only branch). Delete branches on merge
  (`--delete-branch`).
- Stacked PRs: merge bottom-up and retarget each to `main`. Otherwise they merge into their
  parent branch and never reach `main` (#76–#79 did; fixed in #80).
- Never chain `gh pr merge` after `gh pr checks --watch`: the repo doesn't block merges on red
  CI. Check the result, then merge.
- Never run a bare `git merge`: use `git -c core.attributesFile=/dev/null merge` (a global
  rizzler merge driver corrupts files).
- Don't commit when tests failed: gate the commit on the test result, not a `;` chain.
- No `eslint-disable` anywhere (the repo's anti-cheat forbids it).
- Tests must not touch the machine's real services: pass a failing `fetch` in `CliIO` (a real
  Ollama runs on the dev Mac).
- Models for live tests: free or local only. **Don't use the local Bonsai/MLX workers**: their
  server drops tool definitions. Publishing anything public (npm, PRs to other repos, the
  website) needs the owner's go-ahead each time.
- Flaky in CI: `test/integration/process.test.ts` (timing), and the Docker sandbox tests (Docker
  Hub rate limits). Rerun the failed job.
