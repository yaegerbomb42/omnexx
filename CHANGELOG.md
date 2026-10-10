# Changelog

## 0.5.0

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
