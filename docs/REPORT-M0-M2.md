# Omnexx M0–M2 report

## 1. Summary

- **Branch:** `feat/m0-m2-core` · **PR:** https://github.com/yaegerbomb42/omnexx/pull/1 (not merged)
- **CI:** ubuntu-latest × Node 22/24 and macos-latest × Node 22/24. See the PR checks for the run on the final commit. Every step is enforced: format, lint (zero warnings), typecheck, unit + integration + chaos ×20 with coverage thresholds, build, `npm pack`, global install into a temp prefix, `--help`, `doctor --offline`, `systemd-analyze verify` (ubuntu) and `plutil -lint` (macOS) on the generated service files.
- **Commits on the branch:** 28 (small, conventional), head `52385ec`.
- **Size:** `src/` ≈ 9,900 lines in 90 files; `test/` ≈ 5,700 lines in 46 files (plus fixtures). 289 tests.
- **Nothing published, nothing pushed to `main`**, no paid API, Ollama or coding-harness calls were made, `~/omnexx-npm` was not touched, no service was installed on the Mac.

## 2. What works: every acceptance criterion

### M0

| Criterion                                                                                                                                                                           | Status | Evidence                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| CI green on ubuntu/macos × Node 22/24, strict lint/typecheck, zero warnings                                                                                                         | met    | `.github/workflows/ci.yml`; PR checks                    |
| `--help`, `--version`                                                                                                                                                               | met    | `test/unit/cli/program.test.ts`; CI smoke                |
| `init` detects PM + gates, asks, idempotent, `--yes`, injected stdin                                                                                                                | met    | `test/unit/cli/init.test.ts`                             |
| `doctor` reports node/git/rg/key (masked)/docker; never prints a key (unit test); `--offline`; Nimble endpoint, reachability, Ollama version, model, latency; unreachable = warning | met    | `test/unit/cli/doctor.test.ts` (mock Ollama on loopback) |
| Config precedence + zod errors as one actionable line                                                                                                                               | met    | `test/unit/config/load.test.ts`                          |
| `npm pack` installs and runs; runtime deps exactly the approved list                                                                                                                | met    | CI pack/install step; `test/unit/package.test.ts`        |
| Schema has `[budget]` (24 h defaults), `[judge]`, `[judge.nimble]`, `[workers]` (unknown ids allowed, all off; enabling fails until M3)                                             | met    | `load.test.ts`, `doctor.test.ts`, `src/cli/run-deps.ts`  |

### M1

| Criterion                                                                                                                 | Status                   | Evidence                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| ts-failing-test → one checkpoint commit with trailers on `omnexx/<runId>`                                                 | met                      | `test/integration/cycle.test.ts`                                                              |
| impossible-task → rejected, worktree byte-identical to `lastGreen`                                                        | met                      | same                                                                                          |
| Real-API e2e: one cycle < $0.50, cache-read share ≥ 60% from turn 3                                                       | **implemented, not run** | `test/e2e/fix-failing-test.test.ts`; run: `OMNEXX_E2E=1 ANTHROPIC_API_KEY=… npm run test:e2e` |
| Ratchet with a pre-existing failure                                                                                       | met                      | cycle.test.ts "ratchet"                                                                       |
| Anti-cheat: test-deleter, `.skip`, `.only`, protected path                                                                | met                      | cycle.test.ts (4 cases); `test/unit/verify/ratchet.test.ts`                                   |
| Safety: ssh key, `rm -rf ../`, `git push --force`, printing the key, writing outside; zero secret hits in all logs/events | met                      | cycle.test.ts "M1 safety" (greps every file written plus every tool result)                   |
| User checkout untouched during and after                                                                                  | met                      | cycle.test.ts (asserted at VERIFY and after)                                                  |
| Per-cycle caps + pre-flight, run-level `max_usd`                                                                          | met                      | `test/unit/guard/budget.test.ts`; `test/integration/plan-and-loop.test.ts`                    |
| Fresh-context property (cycle 1 vs 500, stable prefix, no transcripts)                                                    | met                      | `test/unit/agent.test.ts`                                                                     |
| Budget property (overshoot ≤ one turn)                                                                                    | met                      | budget.test.ts (300 seeded runs)                                                              |
| Judge off → zero HTTP calls                                                                                               | met                      | plan-and-loop.test.ts; judge.test.ts                                                          |
| Judge interface, none/nimble/llm, breaker, mock-server failure modes, tool-safety logging                                 | met                      | `test/unit/judge/judge.test.ts`                                                               |
| `run --plan-only`                                                                                                         | met                      | plan-and-loop.test.ts                                                                         |

### M2

| Criterion                                                                                                                             | Status                               | Evidence                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| Chaos suite: all §7.2 invariants (20 in CI, 200 nightly)                                                                              | met (20 in CI; 200 in `nightly.yml`) | `test/chaos/chaos.test.ts`: real child supervisors SIGKILLed at seeded random phases |
| Simulated reboot resumes from the right phase < 60 s, no repeated commits                                                             | met                                  | `test/integration/process.test.ts`                                                   |
| `--detach`, heartbeat < 30 s, pause within one turn, resume continues                                                                 | met                                  | process.test.ts (real processes)                                                     |
| goal.md edit picked up next cycle, logged by hash                                                                                     | met                                  | `test/integration/supervisor.test.ts`                                                |
| ntfy: allowed fields only, redacted, mock server                                                                                      | met                                  | `test/unit/notify/ntfy.test.ts`                                                      |
| 30 tasks, 3 forced kills, 10-minute outage, zero manual steps                                                                         | met                                  | chaos.test.ts "finishes with 30 commits"                                             |
| Hierarchical plan (milestone by milestone; failing milestone not done; deletion refused)                                              | met                                  | supervisor.test.ts; `test/unit/core/plan.test.ts`                                    |
| Codemap (new module appears; untouched entries byte-identical; under cap)                                                             | met                                  | agent.test.ts; `test/integration/memory.test.ts`                                     |
| Checkpoints + 8-section report with correct counts; budget-stop and needs-human reports                                               | met                                  | supervisor.test.ts; `test/integration/cli-inspect.test.ts`                           |
| Wrap-up reserve                                                                                                                       | met                                  | supervisor.test.ts                                                                   |
| Fake worker: trailer commit, tree-kill timeout, anti-cheat, tamper → disabled, quota cooldown persisted, `max_concurrent`, no secrets | met                                  | `test/integration/workers.test.ts`                                                   |
| impossible-task parked after 3 → needs-human, exit 2, ntfy                                                                            | met                                  | supervisor.test.ts                                                                   |
| Oscillation detected within one cycle, signal named                                                                                   | met                                  | supervisor.test.ts                                                                   |
| Budget stop exit 3, lastGreen intact, resumable after raising the cap                                                                 | met                                  | supervisor.test.ts                                                                   |
| Judge invariant (advise + arbitrary answers = judge off)                                                                              | met                                  | supervisor.test.ts                                                                   |
| systemd unit / launchd plist valid; linger printed, never sudo                                                                        | met                                  | CI validation steps; `test/unit/daemon/service.test.ts`                              |

## 3. The mechanisms

| Mechanism                        | Implemented                                                                                                                                     | Tested by                                                | Events                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1 Fresh context per cycle        | Context rebuilt from goal, compact plan view, progress tail, notes snapshot, codemap; three cache breakpoints                                   | agent.test.ts property tests; scripted-provider requests | `cycle.context`, `turn` (tokens by class, cacheReadShare)              |
| 2 Lessons file + per-task memory | `remember` tool (typed, dated, capped, add/replace/remove); approachesTried, signatures, evidence on retry; milestone consolidation with guards | store.test.ts, tools.test.ts, memory.test.ts             | `notes.update`, `notes.consolidation`                                  |
| 3 Commands are the judge         | Baseline, ratchet, 8 parsers (on recorded output), anti-cheat, task checks, rollback with saved patch                                           | verify/*, cycle.test.ts                                  | `baseline`, `verify.gates`, `verify.result`, `commit`, `rollback`      |
| 4 Stuck + ladder                 | Consecutive rejections, repeated signature, cycles per task, oscillation by blob hash; rungs: retry with evidence → park; stop-and-ask          | stuck/ladder unit tests, supervisor.test.ts              | `stuck.signal`, `ladder.rung`, `task.parked`                           |
| 5 Budgets + pre-flight           | Worst-case check before every call; per-cycle turns/tokens; run USD/hours/cycles; 80% warning; wrap-up reserve                                  | budget property test, supervisor.test.ts                 | `budget.preflight_stop`, `budget.warn`, `budget.stop`                  |
| 6 Crash-safe resume              | Atomic state, phase machine, lock with boot id + serialized takeover, reconcile, detach, `resume --all`, service units, outage backoff          | chaos, process.test.ts, lock.test.ts                     | `run.resume`, `reconcile.*`, `provider.retry/outage/recovered`         |
| 7 Hierarchical plan + codemap    | Rolling-wave planner, milestone checks, never-delete, incremental codemap with cheap-model purposes                                             | plan.test.ts, supervisor.test.ts, memory.test.ts         | `planner.start`, `plan.written`, `milestone.*`, `codemap.updated`      |
| 8 Checkpoints + report           | Tags per milestone, `checkpoints`, `diff --since`, `REPORT.md` at every terminal outcome                                                        | supervisor.test.ts, cli-inspect.test.ts                  | `milestone.done`, `run.finish`                                         |
| Judge (advisory)                 | none/nimble/llm, fail-open breaker, next-move (advise/steer), drift, similarity, tool safety                                                    | judge.test.ts, supervisor.test.ts invariant              | `judge.decision`, `judge.miss`, `judge.unavailable`, `judge.next_move` |
| Worker lifecycle                 | Interface, quota, semaphore, isolated worktree, push disabled, tree-kill, tamper check, same gates                                              | workers.test.ts                                          | `worker.result`, `worker.tamper`, `worker.skipped`                     |

## 4. Stubbed, deferred or missing

- **M3, not built:** model routing (planner/worker/cheap per turn); in-cycle compaction and tool-result clearing; flaky-test handling; the rolling daily cap (`max_usd_per_day` accepted, not enforced); `sandbox = "docker"` (fails with "not implemented"); in-cycle stuck signals (repeated tool call, no edits after K turns, burn rate).
- **Ladder rungs not implemented:** 2 (escalate model), 3 (re-plan a task; milestone-level re-plan _is_ implemented), 4 (different approach). Plus the M3 "second opinion" worker rung.
- **Next-move options without an action:** `split_task`, `switch_to_strong_model` (logged as `unavailable` in steer mode).
- **Workers:** no real adapters (Aider, OpenCode, Cline, Pi, Hermes, OpenHands, Claude Code); no routing, rotation or judge-assisted choice. The supervisor never calls the worker lifecycle in this build.
- **Other:** `openai-compat` provider (not even a stub), `open_pr` (fails), benchmark harness (M4), npm publish/release workflow (M5). Commit messages and progress summaries are deterministic, not cheap-model drafts.
- **Not run:** the real-API e2e test; chaos ×200 runs only in the nightly workflow.

## 5. Coverage (lines)

| Directory    | Lines | Gate  |
| ------------ | ----- | ----- |
| src/core     | 88.5% | ≥ 85% |
| src/verify   | 99.5% | ≥ 85% |
| src/guard    | 100%  | ≥ 85% |
| src/security | 99.0% | ≥ 85% |
| src/git      | 100%  | ≥ 85% |
| src/judge    | 95.9% | ≥ 85% |
| src/workers  | 97.4% | ≥ 85% |
| total        | 91.1% |       |

Child-process tests (detach, reboot, chaos) don't count towards coverage, which is why `src/daemon` shows low.

## 6. Deviations

See `docs/DECISIONS.md` (D1–D23). In one line each: handoff overrides (D1); TS 6 for typescript-eslint (D2); verified model ids and prices (D3); personal-use pivot (D4); node-test parser (D5); JS fixture (D6); checks decide done, 1–200 tasks (D7); `max_task_cycles` (D8); all-parked = needs-human (D9); commits skip hooks/signing (D10); deterministic commit messages (D11); deterministic report (D12); run-only scratch dir (D13); serialized lock takeover (D14); `budgetExhausted` (D15); assumed Nimble wire format (D16); LLM-judge probabilities (D17); workers lifecycle only (D18); service unit details (D19); bundled test entry (D20); CI placeholder key (D21); deliberate non-implementations (D22); Haiku 4.5 retirement risk (D23).

## 7. Risks and known gaps

- **Host mode is not a sandbox.** Code the agent writes and runs (tests, scripts, `node -e`) has your user's permissions and network. See `docs/safety.md`. Use a dedicated user or VM until docker mode lands.
- **Nimble's request/response shape is assumed** (D16). Fail-open makes a mismatch harmless, but verify before relying on it.
- **Haiku 4.5** (the `cheap` default) may be retired from Oct 15, 2026. Override `[models] cheap`.
- **Cost estimates** use 3 chars/token as a conservative tokenizer stand-in; the pre-flight can stop a little early, never late.
- **Plan concern:** the plan's "finished with N parked" conflicts with the handoff's rung 6. I followed the handoff (D9).
- **Plan concern:** milestone checks can be expensive (a full suite) and run once per milestone on `lastGreen`; on a very large repo, keep them focused.
- **Real-world behaviour is unmeasured.** Everything here is proven with a scripted model. The first real-API run is the e2e test.

## 8. How to try it

```bash
cd ~/Projects/omnexx && git switch feat/m0-m2-core && npm ci && npm run build && npm test
npm link            # puts `omnexx` on PATH from this checkout (undo: npm unlink -g omnexx)
omnexx --version && omnexx doctor
cd <some small repo with tests> && omnexx init
export ANTHROPIC_API_KEY=...   # your own key; costs money
omnexx run --plan-only "…"     # planning only
omnexx run --budget 2 --hours 1 "…" && omnexx status && omnexx logs -f
OMNEXX_E2E=1 npm run test:e2e  # the real-API e2e from M1 (hard $0.50 cap)
```

Detached: `omnexx run --detach …`, then `omnexx status`, `omnexx pause`, `omnexx resume`, `omnexx stop [--now]`, `omnexx report`.

**Nimble on the Mac:** `ollama pull nimble`; bind Ollama to the Tailscale IP (`launchctl setenv OLLAMA_HOST <tailscale-ip>:11434`, restart Ollama); in `~/.config/omnexx/config.toml` set `[judge] kind = "nimble"`, `mode = "advise"` and `[judge.nimble] url = "http://<mac>.<tailnet>.ts.net:11434"`; check with `omnexx doctor`. Details: `docs/judge.md`.

**systemd on the VPS:** `omnexx service install --dry-run` to inspect, then `omnexx service install`; if prompted, `sudo loginctl enable-linger $USER`. Details: `docs/deploy-vps.md`.

## 9. Suggested next steps

M3, in order: (1) docker sandbox (needed before trusting unattended worker use); (2) model routing plus ladder rungs 2–4; (3) in-cycle compaction and tool-result clearing; (4) flaky-test handling and the daily cap; (5) in-cycle stuck signals; (6) the first worker adapters (Aider and OpenCode first), quota rotation and the second-opinion rung.

M4, measure first: run the real-API e2e, then the "Jimmy set" against plain `claude -p --bare`. Track $ per resolved task, cache-hit ratio and turns per task (already in `status --json`), and whether advise-mode judge agreement is high enough to try `steer`.

## 10. Landing page (handoff §9)

**Where it is:** `~/Projects/omnexx-landing/`, **not** `~/Desktop/infra/infra/apps/omnexx/`. Partway through the session this environment lost read access to all of `~/Desktop` ("Operation not permitted" on every path, including the handoff file). I did not try to bypass that. So the page was built and tested in a staging folder, and **the three infra config edits were not made**. Nothing in infra was written, committed or deployed, and `deploy.sh` was not run.

Files (copy them into `infra/infra/apps/omnexx/`):

| File                 | Bytes                                               |
| -------------------- | --------------------------------------------------- |
| `index.html`         | 5,089 (inline CSS + JS, no external requests)       |
| `public/favicon.svg` | 359                                                 |
| `public/robots.txt`  | 23                                                  |
| `public/sw.js`       | 966 (kill-switch, no fetch handler, keep ~6 months) |
| `package.json`       | exactly the plan §6.3 build script, no dependencies |

Tests (`npm run build` → `dist/`, served by `python3 -m http.server` on 127.0.0.1, driven by playwright-core with the installed Chrome, headless; temp dir deleted afterwards):

| Check                                                                                                                           | Result                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `dist/` has index.html, favicon.svg, robots.txt, sw.js; index.html < 10 KB                                                      | pass (5,089 B)                     |
| Only external URLs: GitHub link and `https://omnexx.org/` (canonical/OG); no `<script src`, stylesheet link, `@import` or fonts | pass                               |
| (a) Clipboard holds exactly `npm i -g omnexx`                                                                                   | pass                               |
| (b) Label "Copied" + live-region announcement                                                                                   | pass                               |
| (c) Reverts after ~1.5 s; repeated clicks don't stick                                                                           | pass                               |
| (d) Fallback with `navigator.clipboard` removed copies exactly the command                                                      | pass                               |
| (e) Tab to the button; Enter and Space copy; visible focus ring                                                                 | pass                               |
| (f) No console errors; zero requests to other origins                                                                           | pass                               |
| (g) 320/375/430 px: no horizontal scroll; button ≥ 44×44 (stacks full-width at ≤ 360 px)                                        | pass                               |
| Kill-switch: old cache + registered `/sw.js` → registrations and caches both empty                                              | pass                               |
| nginx block check in Docker                                                                                                     | skipped: Docker daemon not running |

Screenshots: `/tmp/omnexx-landing/desktop-1440x900.png`, `/tmp/omnexx-landing/mobile-390x844.png` (both reviewed).

**Config edits still to make** (I couldn't read the files, so these are the exact changes to apply rather than diffs):

1. `infra/nginx.conf`: replace only the `# Omnexx (omnexx.org) (Port 8116)` block (the one proxying to `omnexx-server:8117`) with:

```nginx
# Omnexx (omnexx.org) (Port 8116): static landing page for the omnexx CLI
server {
    listen 8116;
    server_name omnexx.org www.omnexx.org _;
    root /usr/share/nginx/html/omnexx;
    index index.html;
    absolute_redirect off;
    port_in_redirect off;

    # No tracker on omnexx.org: a server-level sub_filter stops the http-level
    # tracker.js injection from being inherited. This one is a deliberate no-op.
    sub_filter '<head>' '<head>';

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;

    location = / {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
        try_files /index.html =404;
    }
    location = /sw.js {
        add_header Cache-Control "no-store" always;
        add_header Service-Worker-Allowed "/" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
    }
    location / { try_files $uri =404; }
}
```

This block hasn't been run through `nginx -t`. Test it on the VPS as in step 2 below, which restores the backup on failure. 2. `infra/docker-compose.yml`: remove only the `omnexx-server` service (and its comment line); keep the `static-sites` mount `./apps/omnexx/current:/usr/share/nginx/html/omnexx` and port `8116:8116`. Then `grep -rn omnexx-server infra/` should be empty. 3. `infra/deploy.sh`: change `"omnexx:app:8116:omnexx.org:Next.js/Fullstack:omnexx-app"` to `"omnexx:app:8116:omnexx.org:Static:static-sites"`.

**Deploy steps (handoff §9.7, not run):**

0. Recommended first: publish `omnexx` to npm so the install command works on day one (the registry returns 404 today). Review and commit the infra changes your usual way (your own pending edits are in the same files).
1. `cd ~/Desktop/infra && ./infra/deploy.sh omnexx`
2. nginx with backup, test and auto-restore:
   ```bash
   cd ~/Desktop/infra/infra
   ssh ubuntu@147.224.158.118 'cp ~/infra/nginx.conf ~/infra/.nginx.conf.bak-omnexx'
   rsync -az --inplace nginx.conf ubuntu@147.224.158.118:~/infra/nginx.conf
   ssh ubuntu@147.224.158.118 'docker exec static-landings nginx -t && docker exec static-landings nginx -s reload || { cp ~/infra/.nginx.conf.bak-omnexx ~/infra/nginx.conf; echo "nginx -t failed: restored previous config"; }'
   ```
3. Compose and the old container, by hand:
   ```bash
   rsync -az docker-compose.yml ubuntu@147.224.158.118:~/infra/docker-compose.yml
   ssh ubuntu@147.224.158.118 'docker rm -f omnexx-server 2>/dev/null || true'
   ```
4. Nginx Proxy Manager (`:81` over the tailnet): confirm the omnexx.org host forwards to 8116; add `www.omnexx.org`; request a new Let's Encrypt cert for both names; turn on Force SSL, HTTP/2, HSTS (no preload).
5. Verify: `curl -sI https://omnexx.org` → 200 with the new title; `curl -sI https://www.omnexx.org` → 200/301 with valid TLS; `curl -s https://omnexx.org/sw.js` → the kill-switch with `cache-control: no-store`; `curl -s https://omnexx.org | grep -c tracker.js` → `0`; a phone that visited the old site shows the new page after one reload.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
