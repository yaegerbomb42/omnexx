# Live telemetry feed

`omnexx run` (foreground) and `omnexx logs [-f]` show one short line per thing the agent does:

```
12:04:31 ▸ read     src/auth/session.ts:40-120
12:04:32 · route    edit-small → groq:llama-4-70b  nimble p=0.91  48ms
12:04:35 ▸ edit     src/auth/session.ts
12:04:41 ✓ gates    test ✓ 214/214 (6.1s)  lint ✓ (900ms)
12:04:41 ✓ commit   3f2a1c9  M1.T02  2 files +12 −3
omnexx · 2h14m · cycle 37 · task M1.T02 · claude-sonnet-5-5 · 3.4M tok · cache 91% · $4.20 · ✓31 ✗6
```

The last line is a status footer, redrawn in place on a terminal (never when piped).

| Flag          | Shows                                                      |
| ------------- | ---------------------------------------------------------- |
| `-q, --quiet` | Commits, rejections, rollbacks, parked tasks, stops        |
| (default)     | Plus every tool call, gate run, route decision, compaction |
| `--verbose`   | Plus every model turn (tokens, cache share, $, latency)    |
| `--debug`     | Every raw event, one line each                             |
| `--events`    | (`logs` only) raw JSONL                                    |

The feed tails `events.jsonl` from a byte offset, so following a days-long run stays cheap.
`omnexx status --json` adds a `telemetry` block: tool calls and errors, gate runs and pass
rate, rollbacks, compactions, tokens per accepted commit, and the active model and provider.

Glyphs: `▸` action · `✓` success · `✗` failure · `!` warning · `·` info. Colors follow the brand
palette and are off when piped, under `NO_COLOR`, or with `TERM=dumb`.
