# Hooks

Hooks are user-written shell commands that run at fixed points of a cycle. Config: `[[hooks]]`
tables in `omnexx.toml` (schema: `src/config/sections/hooks.ts`, runner: `src/hooks/run.ts`).

```toml
[[hooks]]
on = "pre_commit"            # pre_tool | post_tool | pre_commit | cycle_end | run_end
run = 'gitleaks protect --staged'   # shell command
match = "edit*"              # optional glob over the payload's tool name (tool events only)
timeout = "30s"              # duration string, default 30s
```

## Events

| `on`         | Fires                                        | Blocks?                    |
| ------------ | -------------------------------------------- | -------------------------- |
| `pre_tool`   | before a tool call runs in the agent loop    | yes (non-zero exit vetoes) |
| `post_tool`  | after a tool call finished                   | no                         |
| `pre_commit` | before the harness commits an accepted cycle | yes (non-zero exit vetoes) |
| `cycle_end`  | after a cycle is recorded                    | no                         |
| `run_end`    | when the run reaches a terminal outcome      | no                         |

Hooks run in config order; on a blocking event the first failing hook stops the chain (later
hooks do not run).

## How a hook runs

`runHooks(event, payload, { hooks, cwd, env, exec?, signal?, redact? })` uses the shared command
runner (`src/core/exec.ts`), so call sites pass the run's executor to get the same sandbox,
timeout handling and redaction as gates:

- **stdin**: the payload as JSON, plus the `event` name (`{ ...payload, event }`).
- **env**: the caller's full environment with `OMNEXX_EVENT=<event>` added.
- **cwd**: the worktree (call site decides).
- **timeout**: per-hook `timeout` (default `30s`); a timeout kills the whole process group like
  any other command.

## Blocking semantics

On `pre_tool` / `pre_commit`, a non-zero exit **or** a timeout returns

```ts
{ blocked: true, reason: string, ran: HookRunResult[] }
```

`reason` is the hook's output trimmed to a **2 000-char tail** (the executor interleaves stdout
and stderr, so both feed back), prefixed with `…` when cut, plus `hook timed out after <timeout>`
on timeout, or `hook exited <code> with no output` when the hook was silent. Call sites feed
`reason` back to the agent (as the tool result / rejection reason). Everything else returns
`{ blocked: false, ran }`, where `ran` records `{ on, run, exitCode, timedOut, durationMs }` per
hook that executed.

`match` is a glob (`*` = any run, `?` = one char, everything else literal) tested against the
payload's `tool` field. It only applies to events whose payload carries a tool name; on
`cycle_end` / `run_end` it is ignored.

## Wiring (INTEGRATION)

The call sites live in core files W10 does not edit; the exact `Where/What/Why` entries are in
[integration-notes.md](integration-notes.md) under **W10**: `pre_tool`/`post_tool` in the agent
loop, `pre_commit` in `stepCommit` before `commitCheckpoint`, `cycle_end` in `runOneCycle`,
`run_end` next to `run.finish`.

## Security

Hooks run arbitrary shell with the run's environment — treat `omnexx.toml` like CI config
(trusted, reviewed, never attacker-controlled). Secrets never appear in `run` by convention; hook
output passes through the run's redactor when the call site supplies `redact`.
