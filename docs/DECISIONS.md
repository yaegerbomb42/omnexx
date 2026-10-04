# Decisions

One entry per deviation from `docs/PLAN.md` or non-obvious choice. Newest entries at the bottom.
Format: date, decision, why, alternatives considered.

---

## D1 (2026-10-03) Handoff deviations adopted wholesale

**Decision.** The Oct 3 handoff overrides the plan where they differ:

- The GitHub repo already existed, so it was cloned instead of `git init`.
- Work happens on `feat/m0-m2-core`, which is pushed with a draft PR. Nothing is pushed to `main`, nothing is force-pushed, nothing is published to npm.
- Decisions live in `docs/DECISIONS.md` (this file), not `docs/decisions.md`.
- Linux and systemd are the primary service target (the Oracle VPS); launchd is second.
- A minimum version of budget caps (per-cycle turns/tokens, pre-flight, run-level USD/hours/cycles, `warn_at`) and of stuck detection (3 signals plus ladder rungs 1, 5 and 6) moves from M3 into M1/M2.
- The Nimble fast judge (plan §13) ships in M1/M2 as a `Judge` interface with `none`, `nimble` and `llm` implementations. It is off by default.
- No CI workflow uses an API key or calls a paid API. There is no real-API nightly job; `nightly.yml` runs chaos ×200 only.

**Why.** The handoff says these are deliberate. Budget caps and stuck detection are what keep an unattended run from burning money, so no real run should exist without them.

**Alternatives.** Following plan §12 literally (no push, M3-only guards) was rejected by the handoff.

## D2 (2026-10-03) TypeScript 6.0.x instead of 7.x

**Decision.** Pin `typescript@6.0.3`.

**Why.** TypeScript 7 (the native port) is the npm `latest`, but `typescript-eslint@8.71` declares `typescript >=4.8.4 <6.1.0` as its peer range. `strictTypeChecked` linting needs the type-aware API, so lint would break or be unsupported on 7.

**Alternatives.** TS 7 with `--legacy-peer-deps` (unsupported combination, risk of silent lint gaps); dropping type-aware lint (violates the quality bar).

## D3 (2026-10-03) Model aliases and prices

**Decision.** `src/providers/pricing.ts` maps `opus → claude-opus-5-5`, `sonnet → claude-sonnet-5-5`, `haiku → claude-haiku-4-5-20251001`, with the per-MTok prices from https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-03). Every entry is overridable from `[pricing.<alias>]` in config.

**Why.** The handoff forbids invented IDs or prices. Opus 5.5 cache reads are 0.05× base input, not the usual 0.1×, so the table stores each rate explicitly instead of deriving it from multipliers.

**Alternatives.** Hard-coding multipliers (wrong for Opus 5.5 and Fable 5.1).

## D4 (2026-10-03, late) Change of direction: personal use, 24 h runs, worker backends

**Decision.** Adopt the revised plan (§14, §15) and handoff mid-M0, without restarting:

- Omnexx is a personal tool for one user. Public-product work (multi-user, marketing, comparison claims, a heavy release pipeline) is dropped or demoted. The changesets config stays because it costs nothing, but no Version-Packages workflow will be added.
- M2 gains the hierarchical plan (goal → milestones → tasks, rolling wave), the incremental codebase map, milestone checkpoints (`omnexx checkpoints`, `diff --since`), the morning-after report (`omnexx report`, auto-written at every terminal outcome) and the wrap-up reserve.
- Budget defaults become the 24 h set: `max_usd = 50`, `max_usd_per_day = 50`, `max_hours = 24`, `max_cycles = 300`, `wrapup_reserve = 0.08`.
- M0–M2 build only the `WorkerBackend` interface, the `[workers]` config (all off, `max_concurrent = 1`), the harness-side lifecycle and a fake worker for tests. No real adapters until M3, and no installed harness is ever run.

**How existing work was adapted.** At the time of the change only the plan copy was committed, and the M0 config schema was uncommitted. The schema was edited in place: new budget defaults plus `wrapup_reserve`, and a `[workers]` section where `max_concurrent`/`priority` are fixed keys and every other key is a per-worker table (`[workers.aider]`, as in plan §15.3), validated by the same strict worker schema. Unknown worker IDs are accepted. Enabling one fails at run start with "adapter not available until M3". The plan schema planned for M1 is designed as a tree from the start, so nothing has to be rewritten in M2.

**Alternatives.** Finishing M0–M1 against the old plan and retrofitting later would have meant migrating `plan.json` and the config defaults twice.
