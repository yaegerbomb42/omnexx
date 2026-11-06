# Long Task: PR #146 — Ranked model list with Random / Rank priority / Fallback on quota

Starting at the parent commit of PR #146 (`fd0d20f`), re-implement the ranked model list feature:

The agent should implement:

1. Model list with multiple priority modes (Random, Rank, Fallback)
2. Quota-aware fallback when a model hits rate limits
3. Model ranking and selection logic
4. Fallback chain across models when quota is exhausted

The agent's goal: implement the model pool, ranking, and fallback logic so that when a model hits quota, the system automatically falls back to the next available model according to the configured priority.

Hidden tests (from PR #146) verify:

- Model ranking selects models correctly
- Random priority mode works
- Rank priority mode respects order
- Fallback triggers on quota exhaustion
- Fallback chain works across multiple models

## Success Criteria

- All hidden tests from PR #146 pass
- Repo's existing test suite passes
- Model fallback works correctly on quota exhaustion
