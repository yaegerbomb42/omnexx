# Long Task: PR #170 — Work from a working state, never over the context budget; 1M context level

Starting at the parent commit of PR #170 (`6c40975`), re-implement the working-state and context budget feature:

The agent should implement:

1. Work from a "working state" — always resume from the last known-good state
2. Context budget enforcement — never exceed the configured context window
3. 1M context level support — handle very large contexts efficiently
4. State checkpointing and restore
5. Context compaction when approaching budget

The agent's goal: implement the working-state management, context budget governor, and 1M context support so tasks always run from a valid state and never exceed context limits.

Hidden tests (from PR #170) verify:

- Working state is correctly saved and restored
- Context budget is never exceeded
- 1M context level works correctly
- Checkpoint/restore produces identical results
- Context compaction preserves needed information

## Success Criteria

- All hidden tests from PR #170 pass
- Repo's existing test suite passes
- Tasks work from a working state within context budget
