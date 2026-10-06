# Changelog

## 0.3.0 (unreleased)

- **Interactive session.** Bare `omnexx` opens the TUI: type a goal to start a run, type while it
  runs to steer it, `/help` for commands. Nex, a small animated character, shows what it's doing.
- **Start from an empty folder.** `git init`, a starter `package.json`, checks and `AGENTS.md` are
  written for you.
- **Providers in one step.** Paste an API key, `/connect <name|url> [key]`, or `/chat` with a
  connected model and let it add the rest. Keys never reach the model.
- **Browser checks.** `kind = "browser"` gates start your app on `$PORT` and fail blank pages and
  uncaught JavaScript errors.
- **Helpers and memory.** `task` runs read-only helper agents in parallel; `recall` searches the
  whole run's history; compaction keeps edited files and the last error.
- **Fix:** `omnexx run --budget/--hours/--gate/--model-worker/--sandbox/--push` were ignored by
  the supervisor; they now apply for the whole run, including after `resume`.
- Update notice in the TUI, at most one npm check a day (`OMNEXX_NO_UPDATE_CHECK=1` to turn off).

## 0.2.0

Docker sandbox, model escalation.

## 0.1.0

First release.
