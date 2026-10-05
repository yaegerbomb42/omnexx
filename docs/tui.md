# Interactive session

Run `omnexx` in a repo on a terminal to open the interactive session (`--no-tui`, a pipe or
`TERM=dumb` print help instead). `omnexx watch [runId]` (alias `attach`) opens it attached to
a run.

- **Type a goal and press enter.** Omnexx starts a long run in the background (it survives
  closing the session) and attaches to it. The live feed (docs/telemetry.md) streams into the
  transcript, which stays in your terminal's normal scrollback.
- **While a run is live, typing steers it.** Your text is appended under `## Steering` in the
  run's `goal.md` and applies from the next cycle (`omnexx steer "<note>"` does the same
  from a shell).
- **`/` opens commands** with completion (tab): `/run`, `/plan`, `/steer`, `/attach`,
  `/detach`, `/pause`, `/resume`, `/stop`, `/status`, `/diff`, `/report`, `/runs`, `/init`,
  `/doctor`, `/quiet` `/normal` `/verbose`, `/help`, `/quit`. Any other `/<command>` runs
  `omnexx <command>` with its output in the transcript (e.g. `/providers list`).
- **Keys:** enter submit · ↑/↓ history · tab complete · esc / ctrl+u clear · ctrl+p plan panel ·
  ctrl+c leave (runs keep going).
- The status bar shows the attached run: live dot, id, elapsed, cycle, task, model, tokens,
  cache hit, spend, commits and rejections.

Turn-by-turn chat (Claude Code style, no long run) is planned; for now every goal is a run.
