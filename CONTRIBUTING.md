# Contributing

This is a personal tool, but the bar is production quality.

```bash
npm ci
npm run check        # format:check, lint (zero warnings), typecheck, tests with coverage, build
npm run test:unit | test:integration | test:chaos
OMNEXX_CHAOS_ITERATIONS=200 npm run test:chaos
```

Rules:

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM, Node ≥ 22. No `any`, no non-null assertions, no swallowed errors. Errors are `OmnexxError` subclasses with a code and a hint.
- Runtime dependencies are fixed to the list in `docs/PLAN.md` §5.5. Propose additions in `docs/DECISIONS.md` first.
- Tests never touch the network (loopback mocks only), never need an API key, and never run a real coding harness. The scripted provider (`test/support/scripted-provider.ts`) drives integration and chaos tests. Every test that touches git uses a temp repo and an isolated `OMNEXX_HOME`.
- Coverage ≥ 85% lines in `src/core`, `src/verify`, `src/guard`, `src/security`, `src/git`, `src/judge`, `src/workers`.
- Never weaken or skip a test to get green.
- Record non-obvious choices in `docs/DECISIONS.md`.
- Real-API tests: `OMNEXX_E2E=1 npm run test:e2e` (costs money; never in CI).
