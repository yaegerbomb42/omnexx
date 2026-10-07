# Changelog

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
