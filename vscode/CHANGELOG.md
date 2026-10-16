# Changelog

## 0.14.1

- Built on omnexx 0.18.1: no idling after a rate limit, stops as soon as the work is done and
  verified, and commands never outlive the run.

## 0.14.0

- Built on omnexx 0.18.0: works from a concise working state and never goes over your Memory
  budget (now up to 1M); saved Agent settings keep the fast think-first loop; no more lock-out
  after a rate limit.

## 0.13.0

- Built on omnexx 0.17.0. **Settings**: section chips, icons and subtitles, folding sections,
  skill switch / hide / delete, MCP icons and descriptions, quiet "Saved ✓", "Max reply length".
  **Chat**: keeps working when out of room, Compact always works, New chat keeps History.

## 0.12.1

- **More color in Settings**: each section has its own color (edge, tint, heading, sliders and
  buttons), taken from your theme's palette.

## 0.12.0

- Built on omnexx 0.16.0: `read_symbol`, verified repo facts, and checks that start while the
  model is still writing.

## 0.11.0

- Built on omnexx 0.15.0: leaner search, cleaner command output, lazy MCP, smarter edits and
  recovery; New chat keeps the previous conversation in History.

## 0.10.0

- Built on omnexx 0.14.0: the think-first loop, the **Agent** card (effort, context, time and
  token sliders), a ranked model list with Random / Rank priority / Fallback on quota, a provider
  gallery with Test, **MCP servers** and **Skills** sections, and a fuller context inspector.

## 0.9.0

- Built on omnexx 0.13.0: zero-config Ollama (a **Pull it now** button when no model fits), run
  estimates under the reply countdown, parallel reads, and cleaner web and browser tools.

## 0.8.3

- Built on omnexx 0.12.0.
- **No more separate live log**: actions, thinking and notes show inline in the conversation,
  between the messages they belong to.
- **History** replaces Runs: past chats and runs under Today, Yesterday and Earlier, named by
  what was asked ("Fix arcade nav buttons"), with when and how it went. Click a chat to reopen
  its transcript and carry on.
- **Reply countdown**: while the model answers, the working line shows "est. 5s" from that
  model's recent response times (scaled by prompt size), then "taking longer… 7s".

## 0.8.2

- **Compact chat panel**: needs much less scrolling in a narrow sidebar. Stats sit on one row,
  the header, mode bar, step cards, live log and composer are slimmer, and the conversation gets
  the room back.
- One text scale based on the editor font size: no oversized header, nothing too small to read.
- **Context inspector**: the context line reads "Context 42k / 128k · Inspect ›" and opens a list
  of everything the model gets next turn (system prompt, tool definitions, chat history), each
  with its token count. Open an item to read it, edit or delete it, or restore the default system
  prompt and tools. Edits change the next request (and invalidate the prompt cache). Context files
  and sections are one click away.

## 0.8.1

- New store description; the screenshot shows on the store page again.

## 0.8.0

- Built on omnexx 0.11.3: guided autonomous runs, runs without tests or git, quieter chat
  (thinking shows the decision, tool lines name their target), smarter search, forgiving tool
  arguments and edit line hints.

## 0.7.0

- Built on omnexx 0.10.0: fast path for small goals, writing runs (books, reports), fewer
  tokens per task and fewer tool slips.
- **Browser settings**: engine (Chromium or Camoufox), visible window or headless, profile folder
  and session name, saved to your config.

## 0.6.0

- **omnexx is built in.** The extension ships its own copy of omnexx and runs it on the editor's
  Node, so it works right after install. A global `omnexx` of the same version or newer is used
  instead, and the `omnexx.path` setting overrides both.
- Settings shows which omnexx runs the panel, with **Install omnexx for your terminal** (Homebrew
  when present, else npm).

## 0.5.0

- **Drag-and-drop roles**: drag models from your palette onto Chat, Planner, Worker, Quick jobs
  and Helpers; one model can serve several roles, a role can hold many, each with a routing
  strategy (Priority, Random, Least busy, Smart).
- The context bar explains its number: prompt, tools and chat.
- Fits narrow panels: "Auto" in the mode bar, 2×2 stats, settings that wrap instead of overflowing.
- Needs omnexx 0.9.0.

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
