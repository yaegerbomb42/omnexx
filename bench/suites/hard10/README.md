# hard10

Ten harder tasks for head-to-head runs, where jimmy10's small single-file tasks no longer
separate the agents. Each task is a small but realistic repo (TypeScript, Python, or both), and
most need reasoning across several modules.

```sh
set -a; . ~/.omnexx-bench.env; set +a
npm run bench -- --suite hard10 --agents omnexx,cline,openhands --endpoint DEEPSEEK --out hard10-run --reps 3 --concurrency 4
npm run bench -- --suite hard10 --agents omnexx --out x --dry-run   # list the runs only
bench/suites/hard10/validate.sh                                     # reference passes, start fails
```

## Layout

Each `task-*/` directory holds:

- `goal.md`: the prompt (the first heading is the task title).
- `setup.sh`: copies `repo/` into the work dir (task-05 also runs `npm install` for jsdom).
- `repo/`: the starting repository the agent sees.
- `check.sh` + `hidden/`: the hidden acceptance check. It runs the repo's own tests, then hidden
  tests copied to a temp dir, so the agent can neither read nor edit them.
- `solution/`: a reference solution overlaid on the work dir (`solution/.delete` lists files it
  removes). `validate.sh` and `test/integration/bench-hard10.test.ts` check that the starting
  repo fails and the reference passes.

## Rules the checks follow

- **Behavior, not implementation.** Checks call the public API or the CLI and compare outputs.
  The only structural checks are ones the goal states as requirements (task-04: a package, no
  function over 40 lines, no module-level cache).
- **Every name a check touches is in the goal.** Goals spell out exported names, signatures,
  CLI flags, output fields and DOM structure, so no agent fails over a naming choice (jimmy10's
  task-08 failed agents over an ambiguous field name). Error messages are free text unless the
  goal quotes them; checks then compare paths or types, not wording.
- **Oracles over hand-picked cases** where possible: task-04 and task-09 compare against a
  frozen copy of the original code on thousands of seeded random inputs; task-03 cases were
  cross-checked against npm's `semver`.
- Python is stdlib-only and works on Python 3.9+; TypeScript runs through Node's type stripping
  (Node >= 22.18, erasable syntax only), so no task needs a build step.

## Tasks

| Task                             | Kind                           | Lang    | What makes it hard                                                                                                                                                                                         |
| -------------------------------- | ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-01-ledger-report-bug        | bug hunt, cross-module         | Python  | Two independent root causes in different modules (float money in `money`/`rates`, string-sliced months in `periods`); fixing one leaves the check red. Half-up rounding only at display; no `-0.00`.       |
| task-02-editor-undo-transactions | multi-file feature             | TS      | Undo/redo with invertible commands, nested transactions, rollback on throw, no-op edits, history limit, exactly-once notifications. A seeded random edit sequence must round-trip through undo/redo.       |
| task-03-semver-range-issue       | issue fix (SWE-bench style)    | TS      | Caret semantics on 0.x, SemVer §11 prerelease precedence, npm's prerelease opt-in rule, and the `-0` upper bound subtlety. 35 range cases match npm `semver` exactly.                                      |
| task-04-shipping-refactor        | refactor + feature             | Python  | Split a 100-line function into a package with exact output parity (4,000 random orders against a frozen oracle, quirks included), remove a buggy global cache, then add a carrier without breaking parity. |
| task-05-data-table-widget        | frontend, headless DOM         | JS      | Sort types, stable sort with empties last both ways, tri-state `aria-sort`, debounced filter, empty state, `update`/`destroy`, no mutation of input, no globals. Checked in jsdom.                         |
| task-06-pipeline-scheduler-bugs  | bug hunt, cross-module         | Python  | Four reported symptoms from three modules: cycle check without a recursion stack, transitive skipping, off-by-one retries, inverted priority. 150 seeded random DAGs check the invariants.                 |
| task-07-layered-config           | multi-file feature             | TS      | Defaults < files < env < argv, env name mapping (`APP_DB__POOL_SIZE` → `db.poolSize`), type coercion, every error collected with its path, schema as the single source of truth.                           |
| task-08-telemetry-protocol-v2    | cross-language feature         | Py + TS | Change a wire format on both sides: Python producer emits v2 (ISO ms timestamps, raw units, nulls), TS consumer reads v1/v2/mixed with unit conversion, missing counts and junk-line accounting.           |
| task-09-booking-report-perf      | performance, behavior-preserve | Python  | Two hotspots in two modules (list-membership dedupe, quadratic occupancy); fixing one is not enough for 300k bookings within the time limit. Output must equal the original on 600 random inputs.          |
| task-10-template-engine-issue    | issue fix (SWE-bench style)    | Python  | Naive splitting on pipes and commas in expression parsing, plus loop scoping in the renderer; nested loops at any depth, quotes/parens/pipes inside literals, no mutation of the caller's context.         |

## Why not vendored SWE-bench instances

SWE-bench Lite/Verified instances are MIT-licensed, but each needs its upstream repository at a
pinned commit (Django, SymPy, scikit-learn, ...): hundreds of MB per instance plus a pinned
Python environment and network access at setup. That is too large to vendor here and too slow
for a local `--reps 3` run. task-03 and task-10 are written in the same form instead: an issue
report as the goal, a library with existing tests, and hidden fail-to-pass plus pass-to-pass
tests.

## Claude Code

`--agents claude-code` with `--endpoint PREFIX` drives `claude -p` headless against the same
provider. `claude` only speaks the Anthropic Messages API, so it cannot use the bench's OpenAI
metering proxy: set `PREFIX_ANTHROPIC_BASE_URL` to the provider's Anthropic-compatible URL (for
DeepSeek, `https://api.deepseek.com/anthropic`); it reuses `PREFIX_MODEL` (or
`PREFIX_ANTHROPIC_MODEL`) and `PREFIX_API_KEY`. The runner pins every model role to that model
and runs with a private config dir and no inherited Anthropic credentials, so it never falls back
to the user's own login. Tokens come from `claude`'s own JSON usage report, not the meter, so
compare its token numbers with that caveat. Without `PREFIX_ANTHROPIC_BASE_URL`, the bench
refuses to run claude-code under `--endpoint`.
