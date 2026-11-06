# Long Task: PR #143 — Think-first loop session for the fast path

Starting at the parent commit of PR #143 (`12cba2c`), re-implement the think-first loop session feature:

The fast path should run as a think-first loop session where:

1. A planner model thinks first (separate turn) before the worker model acts
2. Helper agents are off by default
3. The loop supports multiple rounds with rethinks and rewinds

The agent's goal: implement the `think-loop.ts`, `think-loop-run.ts`, `think-loop-speculative.ts`, `think-loop-check.ts` modules and wire them into the run pipeline so that tasks execute as think-first loop sessions.

Hidden tests (from PR #143) verify:

- Think loop produces correct session results
- Loop rounds, rethinks, and rewinds work correctly
- Helper agents are disabled by default
- Speculative checks integrate with the loop

## Success Criteria

- All hidden tests from PR #143 pass
- Repo's existing test suite passes
- The fast path uses think-first loop sessions
