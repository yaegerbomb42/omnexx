# Long Task: PR #147 — Agent sliders: effort per task/turn, context, time, max tokens

Starting at the parent commit of PR #147 (`3909666`), re-implement the agent sliders feature:

The agent should implement:

1. Per-task sliders for effort, context, time, and max tokens
2. Per-turn sliders for adjusting effort mid-task
3. Context budget management with sliders
4. Time limit sliders per task
5. Max token sliders per model call

The agent's goal: implement the slider UI and backend logic so users can control how much effort, context, time, and tokens each task and turn consumes.

Hidden tests (from PR #147) verify:

- Sliders correctly adjust model parameters
- Context budget is enforced
- Time limits are respected
- Max tokens cap model output
- Per-turn adjustments work

## Success Criteria

- All hidden tests from PR #147 pass
- Repo's existing test suite passes
- Agent sliders control execution parameters
