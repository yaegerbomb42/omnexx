Fixture repos for integration and chaos tests. Each is copied into a fresh temp git repo per test.
They use Node's built-in test runner (`node --test --test-reporter=tap`), so no `npm install` is needed.
(`ts-failing-test` keeps the name from the plan; it is plain ESM JavaScript so no compiler is required.)

- `ts-failing-test`: `add` subtracts; two tests fail until it's fixed.
- `impossible-task`: two tests demand `add(2,2)` be both 4 and 5. No change can pass both.
- `ratchet`: the target test (`add adds`) fails, and an unrelated test already failed before the run.
