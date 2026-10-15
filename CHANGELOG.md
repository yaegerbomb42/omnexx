# Changelog

## 0.12.0

- **Chat proposes a plan** for vague or larger requests ("I looked at X. Plan: 1) … Go ahead?")
  instead of asking a menu of questions; small clear requests are just done.
- **Run from anywhere**: started in `/` or your home folder, a run gets its own new folder under
  `~/omnexx-projects`.
- **Fewer tokens and less time**: tools stay in the cached prompt prefix on Chat Completions
  endpoints; no false rejections from coverage output or tests-only diffs; audit follow-up is
  capped; coverage reports stay out of commits; ported tests aren't treated as deleted; every
  edit counts as progress for the stuck signal; agent commands stop after 2 minutes by default.
- Context inspector, chat history and response-time estimates for the VS Code panel.
- Terminal chat: a calm one-line header (the animated character only with `OMNEXX_MASCOT=1`).

## 0.11.3

- Notes from a command ("started a git repository", "no tests configured") no longer show as red
  errors in the chat view; only real failures do.
- Tools take the argument names models use (`line_start`, `file_path`, `query`, …) and ignore
  extras like `max_results` instead of failing the call.
- An edit whose text appears more than once says on which lines, so the model can pick the one
  it means instead of re-reading the file.

## 0.11.2

- **Search scopes itself**: files it can't read are skipped instead of failing the whole search;
  dependency, build and cache folders are left out (and `Library`, `.config` and the like when
  working in a home folder); at most 20 matches per file; a search that hits too much says
  which folders the matches are in, so the next one can narrow.

## 0.11.1

- **Quieter chat**: thinking lines show the decision ("Let's list that path") instead of the
  request the model restates every turn, and a repeated thought isn't printed again.
- Tool lines say what they act on: "listing infra/apps" instead of "using list", an invented
  tool name shows as the tool that ran, and an empty search reads "listing the files".

## 0.11.0

- **Guided autonomous runs**: `/autonomous` (or `/auto`) with nothing after it asks how long
  (30 minutes to 24 hours, or type a time like `90m`), then what to work on; enter on an empty
  line keeps improving the repo.
- **Runs work without tests or git**: with no test command, each task's checks and the reviewer
  decide what is kept (no more one-cycle limit); a folder that isn't a git repository is tracked
  first (git init, a `.gitignore`, a first commit) so every change can be undone.

## 0.10.0

- **Fast path**: small goals get one pass on the whole goal, gated and reviewed like any cycle;
  the planner takes over only if it doesn't get there (`[plan] mode = auto|fast|full`).
- **Planning effort for long runs**: `--plan-helpers N` (planner helpers at once) and
  `--plan-milestones N` (a cap the first plan is held to).
- **Writing runs**: books, reports and research documents, no tests needed ("write me a book
  about…" or `--kind writing`). An outline and a bible first, a task per chapter with word-count
  and placeholder checks, an editor-style reviewer, and chapter summaries in the context map.
- **Far fewer tokens** (head-to-head bench, same model as Cline and OpenHands): an early audit
  skips padded milestones, the end audit judges only what was asked, the reviewer blocks only on
  evidence, review findings are amended instead of redone, and committed `node_modules` is no
  longer described file by file. Most bench tasks now take 8–19k fresh tokens, down from
  63k–2.4M.
- **Fewer tool slips**: a `list` tool; invented tool names (`print_tree`, `ls`, `cat`, `grep`…)
  run the real tool; an empty search lists files; chat turns that circle are told once, then
  stopped; dev servers run 20 s and are stopped for you; "Missing script" names the scripts that
  exist.
- **Clearer terminal**: your messages, tool use, thinking and errors each have their own look.
- **Nimble judge** speaks Ollama's current systemone format. The planner falls back to the next
  model when one keeps failing, and a stuck task asks for a different approach before switching
  models.
- **Bench**: Cline and OpenHands runners behind a metering proxy (`--endpoint PREFIX`).

## 0.9.0

- **Routing strategies per role**: priority, random, least busy (parallel helpers spread over
  providers) or smart (most capable first), in `models.routing` or the editor.
- **Leaner requests**: tool definitions are 22% smaller on every call (short skill and agent
  lists; `skill` with name "list" shows them in full).
- **Browser profiles and Camoufox**: `browser.profile` reuses a profile's logins (opt-in),
  `browser.session_name` keeps the agent's own cookies between runs, and
  `browser.engine = "camoufox"` drives the anti-detection Firefox through Playwright.
- **Fewer wasted cycles** (found by the new benchmark): verify-only tasks with nothing to change
  are done instead of retried until parked; re-reading a file after editing it no longer counts
  as a loop; one cut-short attempt retries before the ladder climbs.
- **Benchmark** (`npm run bench`): the jimmy10 suite with hidden checks; `--model` pins one free
  model, `--context lean|full` compares context modes.

## 0.8.0

- **Leaner context.** Command output leads with the test outcome and is capped at ~3k tokens
  (full log via `read_log`); results that later steps superseded (a file read again, a failure
  that later passed) are pruned without a model call.
- **Optional context sections** (`context.sections`): role, codemap, intent, lessons and progress
  are each pinned, optional (listed with sizes, opened on demand) or hidden. The codemap is now
  optional by default.
- **Role card** per task, generated from the task and editable; `.omnexx/role.md` adds repo-wide
  guidance.
- **Model roles**: pick models per role (chat, planner, worker, quick jobs, helpers); parallel
  helpers spread across providers (`models.helpers`, `models.spread_helpers`).
- **Stalls handled.** A hung step is aborted after `stuck.max_silence` (45m) and retried; a run
  where no model can take a call stops after `budget.max_provider_wait` (6h). `runs` and
  `status` report health: working, quiet, waiting, stalled, dead.

## 0.7.0

- **Live browser view.** `browser.live_view` (on by default): after each page-changing browser
  action omnexx saves a screenshot under the run's logs (never the repo) and emits
  `browser.frame`, so the VS Code panel can show what the agent sees.
- **Helpers in the panel.** `chat-server` reports each helper (subagent) starting and
  finishing, with turns and cost, for the panel's Crew view.
- `chat-server`: `testProvider`, and clearing a chat now waits for its notes to be archived.

## 0.6.0

- **Autonomous runs keep going.** With `run --for`, a stretch with no accepted commit no longer
  stops the run to ask: the stalled task is parked (listed in the report) and the run moves on.
  It still stops after `autonomous.max_idle_rounds` such recoveries in a row.
- `omnexx chat-server`: the interactive session as JSON lines on stdin/stdout, for editor
  panels. It powers the VS Code extension's new chat panel (extension 0.2.0), including adding
  and removing providers and keys.
- Chat sessions count their own tokens, turns and tool calls.

## 0.5.0

- `omnexx runs --json` and `omnexx plan --json` for editors and scripts.
- **VS Code extension** (`vscode/`, not yet published): a runs sidebar with each run's live
  milestones and tasks, Start Run, Autonomous for N Hours, Open Chat in Terminal, and Watch /
  Pause / Resume / Stop per run.
- **Autonomous mode.** `omnexx run --for 8h "<goal>"` (or `/autonomous 8h`) keeps improving the
  repo until the time is up: improvement rounds with no round cap, each on the next focus area,
  work blocked by a parked task skipped instead of stopping to ask.
- **Context scopes.** A `context` tool the agent reads only when it helps: `general` (goal,
  intent, lessons), `repo` (codebase map), `heat` (files changing most) and `recent`, each
  capped, with notes the agent rewrites itself; repo notes carry over to later runs.
- **Live todos.** Workers keep a checklist you can watch tick off in an attached run, and get one
  reminder if they stop with items open.
- **Connectors.** `omnexx connect` (or `/apps`): 26 free apps. Notion, Linear, Jira and
  Confluence, GitLab, Sentry, Supabase, Stripe, Todoist and more sign in through the browser
  (MCP OAuth); GitHub and Slack take a token; Google Workspace runs with your own Google client.
- **Email over IMAP.** `omnexx connect email`: an address and an app password for Gmail,
  Outlook, iCloud, Yahoo or Fastmail. Search, read and draft; sending only if you allow it.
- **Ollama in one command.** `omnexx --ollama` connects a local Ollama and picks a coding
  model; a first run with no provider connects a running Ollama by itself.
- A planner model that never calls a tool now says so (it may not support tool calling)
  instead of "could not produce a valid plan".
- Installer: `curl -fsSL https://omnexx.org/install.sh | sh`.

## 0.4.0

- **Any provider, set up in one step.** 24 hosted providers by name (OpenAI, Gemini, xAI,
  Mistral, DeepSeek, Groq, Cerebras, OpenRouter, Together, Fireworks, NVIDIA, Moonshot, Z.ai,
  Qwen/DashScope, SiliconFlow, DeepInfra, Hugging Face, Perplexity, Cohere, Vercel AI Gateway,
  GitHub Models, Novita, Hyperbolic, SambaNova), plus Anthropic and 6 local servers (Ollama,
  LM Studio, vLLM, llama.cpp, LiteLLM, Jan). Paste a key, even inside a sentence ("my mistral
  key is …"), and omnexx adds the provider; keys never reach a model. `/connect env` adopts the
  keys already in your environment without copying them.
- **First-run welcome**: connect a model, ask, review, in three steps.
- **Model pool** (`/models`): tick any number of models; pick top-first, random (a daily
  shuffle) or smart (a local Nimble model picks per action). Each model is used until it runs
  out of quota, then the next; the quota ledger is per model and shared by every session.
- **Earned done.** Every change gets an independent review before commit, and a run may only
  finish after an audit against your "done when" list. Review runs on your worker models by
  default (no paid model unless you configured one).
- **runningContext**: a living note per task that every cycle starts from, archived when the
  task is done.
- **Chat**: plan mode, `/undo`, `--continue`, `omnexx -p` for scripts, custom slash commands
  (`.omnexx/commands`, `.claude/commands`), image attachments, `/agents` to watch every run on
  this machine, and Nex, the eye that follows your cursor.
- **Memory and search**: lessons persist per repo across runs and chats; `semantic_search`
  finds code by meaning.
- **Runs**: a walkthrough per milestone, an optional PR at the end, Slack/Discord webhooks, a
  hardened browser tool for multi-step web tasks.

## 0.3.0

- **Works like Claude Code.** Bare `omnexx` opens a chat that codes in your checkout: every
  action shows as it happens (`▸ running test suite`, `▸ writing code to test.py`,
  `▸ browsing alexa.com`, `thinking: …`), replies stream in, Esc stops a turn, and anything you
  type while it works reaches it at its next step. A todo panel shows its checklist. `/model`,
  `/compact`, `/diff` (an in-place diff viewer), `@file` completion, multi-line input, and
  context use in the status bar. Long chats are trimmed and summarized automatically.
- **Long unattended runs** with `/run <goal>` (or shift+tab): plan, then cycle on a branch until
  your checks pass. Start from an empty folder and it sets up git, checks and `AGENTS.md`.
- **Any model.** Paste an API key, `/connect <name|url> [key] [--name x]`, or `/setup` to have a
  model add providers for you. `[models] chat` sets chat's model; OpenAI-compatible endpoints
  stream, including reasoning.
- **Browser checks.** `kind = "browser"` gates start your app on `$PORT` and fail blank pages
  and uncaught JavaScript errors.
- **Sturdier with weaker models** (found in unattended runs on free models): forgiving plan and
  tool input, run-wide anti-cheat lessons, no split cascades, a request the provider always
  rejects no longer wedges a run, and failed tool calls log why.
- **Helpers and memory.** `task` runs read-only helper agents in parallel; `recall` searches the
  whole run's history.
- **Fix:** `omnexx run --budget/--hours/--gate/--model-worker/--sandbox/--push` were ignored by
  the supervisor; they now apply for the whole run, including after `resume`.
- Update notice in the TUI, at most one npm check a day (`OMNEXX_NO_UPDATE_CHECK=1` to turn off).

## 0.2.0

Docker sandbox, model escalation.

## 0.1.0

First release.
