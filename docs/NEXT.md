# Next steps (handoff)

Written 2026-10-09 at the end of a session. Start here. When an item is done, tick it, note
the PR, and append a session entry to the log in [TODO.md](TODO.md).

State at handoff: `next` has everything through #87 (version 0.5.0). `main` was synced to
`next` at #83 and is behind again. npm still has only `omnexx@0.1.0`.

## Waiting on the owner (Jimmy)

- [ ] **npm trusted publisher.** On https://www.npmjs.com/package/omnexx/access, under Trusted
      Publisher, add GitHub Actions: owner `yaegerbomb42`, repo `omnexx`, workflow `release.yml`,
      environment `npm`. Then tell the agent, which does the release steps below.
- [ ] **Host the installer.** The website manager serves `scripts/install.sh` as plain text at
      `https://omnexx.org/install.sh`, ideally proxying or redirecting to
      `https://raw.githubusercontent.com/yaegerbomb42/omnexx/main/scripts/install.sh` so it never
      goes stale.
- [ ] **Approve the outside listing PRs** (they post publicly under the owner's account; see below).
- [ ] **Live-test the new features** and report errors:
  - `omnexx connect notion` (browser sign-in). Also try `figma` and `vercel`, which may refuse
    unapproved apps.
  - `omnexx connect email` with a Gmail app password (https://myaccount.google.com/apppasswords),
    then ask the chat to summarize recent mail.
  - `omnexx --ollama`.
  - A long autonomous run: `cd ~/Desktop/infra && omnexx run --detach --for 8h --gate "npm --prefix infra/apps/mynow run build" "Improve the mynow app in infra/apps/mynow. Only change files in that folder."`.
    Needs a free model that can call tools (not Bonsai).
- [ ] Optional, later: a PyPI account (for `pip`/`uvx`), and a VS Code Marketplace publisher
      plus an Open VSX sign-in.

## Agent's queue, in order

1. **Release 0.5.0** (after the trusted publisher exists):
   - PR `next` → `main` (merge commit, not squash; CI green apart from the known SonarCloud
     whole-diff failure).
   - `git tag v0.5.0 <main sha> && git push origin v0.5.0`. `release.yml` checks the tag
     matches package.json, runs lint, typecheck and tests, then `npm publish --provenance`.
   - Verify `npm view omnexx version` shows 0.5.0, and `npx omnexx@0.5.0 --version` works.
2. **Listing PRs** (only after 0.5.0 is on npm and the owner approved):
   - ollama/ollama README "Community Integrations": `[Omnexx](https://github.com/yaegerbomb42/omnexx) - long-running coding agent harness with one-command Ollama support (npx omnexx --ollama)`.
     Title "Add Omnexx to Community Integrations"; short, polite description.
   - Awesome-Ollama, Awesome-LLM-Agents: the same line, in each list's format.
   - Skip the LiteLLM docs (omnexx only consumes LiteLLM as one endpoint).
   - The README wants a screenshot or terminal GIF first: record one with `vhs` showing
     `omnexx --ollama`.
3. **Connector follow-ups** (from live-test reports): fix whatever breaks. Known gaps:
   - Asana and Square were left out: their dynamic client registration is only on deprecated SSE.
   - Box, HubSpot remote, Asana v2: no dynamic registration.
   - Salesforce and Zoom have no free path.
   - The `google` connectors need the user's own Google client: Gmail's restricted scopes need
     Google's paid CASA review for a shared one.
4. **Standalone binary** (when there's demand for `pip`/`uvx`; about 1–2 days):
   - Build one-file binaries (bun compile or node SEA) for darwin x64/arm64, linux x64/arm64 and
     win x64/arm64 in CI on tags.
   - Use them in `install.sh` when Node is missing.
   - Wrap them as per-platform PyPI wheels (the ruff pattern) so `uvx omnexx` needs no Node.
   - Optional Homebrew formula.
   - macOS signing needs an Apple developer account.
5. **VS Code extension** (v1): commands for "start run" and "autonomous for N hours", a runs
   sidebar with the live todo list, and "open chat in terminal". Publish to the Marketplace and
   Open VSX.
6. Older backlog (see TODO.md): W13 bench, audits of the W1/W2/W3/W9 boxes, and open SonarCloud
   findings from #20.

## Rules learned this session

- PRs go into `next`; `main` only gets `next` through a PR. Delete branches on merge
  (`--delete-branch`).
- Stacked PRs: merge bottom-up and retarget each to `next`. Otherwise they merge into their
  parent branch and never reach `next` (#76–#79 did; fixed in #80).
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
