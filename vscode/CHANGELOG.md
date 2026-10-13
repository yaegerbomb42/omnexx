# Changelog

## 0.4.0

- **Context explorer:** see every context file with its token cost, set each section to
  Pinned, Optional or Hidden, and edit notes and the role card.
- **Who does what:** choose models per role; spread helpers across providers.
- Runs view shows health (working, quiet, waiting, stalled, dead) with Resume and Stop.
- Fixes: the model shown follows the model in use; auto-approve doesn't post `/yolo`; higher
  contrast in the live log (12-hour clock) and settings; new providers are tested on add.
- Needs omnexx 0.8.0.

## 0.3.0

- **Crew view:** helpers (subagents) appear as cards wired to the head agent: working, then
  reported back with turns, time and cost.
- **Browser view:** a mini browser window with the agent's latest page after each action.
- **Model picker:** a searchable popover grouped by provider, from the header or Settings.
- **Settings:** provider tiles with search, a Test button per provider (run when Settings opens),
  colored state edges.
- More color throughout, a brighter logo and a new activity-bar icon. Needs omnexx 0.7.0.

## 0.2.0

- **Chat panel** in the sidebar: session stats (uptime, turns, tokens, cost, context), Act /
  Plan / Autonomous modes, Ask first or Auto-approve, a step timeline, a live log, and a
  composer with steer, pause and stop.
- Pick the model or add an API key or endpoint from the panel; settings under the gear.
- Needs omnexx 0.6.0 (`omnexx chat-server`).

## 0.1.0

- Runs sidebar: runs for the open folders, each with its milestones and tasks, refreshed while
  a run is live.
- Commands: Start Run, Autonomous for N Hours, Open Chat in Terminal, and per run Watch, Pause,
  Resume and Stop.
