# Integration notes

Workstreams never edit shared core files. When you need a change outside the files you own,
add an entry here (newest first, under your workstream) and the integrator wires it in.

## Extension points (live on `next`)

| Add a…         | Create                                                                                                  | Then add one line to                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tool(s)        | `src/tools/extra/<name>.ts` exporting `source: ToolSource` (`src/tools/extra/types.ts`)                 | `src/tools/extra/index.ts`: `export { source as <name> } from './<name>.js';`           |
| Config section | `src/config/sections/<name>.ts` exporting `<name> = z.strictObject({...}).prefault({})`                 | `src/config/sections/index.ts`: `export { <name> } from './<name>.js';`                 |
| CLI command    | `src/cli/commands/<name>.ts` exporting `register: CommandRegistrar` (`src/cli/commands/extra/types.ts`) | `src/cli/commands/extra/index.ts`: `export { register as <name> } from '../<name>.js';` |
| Event types    | emit `"<area>.<verb>"` names through `run.events.emit`; list them in your docs page                     | –                                                                                       |

Rules: core tools stay first; extra tools are sorted by name, and duplicate names throw. The
config section name is the TOML table name. Keep barrel lines sorted to avoid merge conflicts.

## Entry format

```
### W<N> <short title>  (branch ws/<N>-<slug>)
- Where: src/<file>.ts, function <name>
- What: <the call or change needed>
- Why: <one line>
```

## Pending

### W10 run_end hooks at terminal outcomes (branch ws/10-instructions)

- Where: src/core/supervisor.ts, next to the `run.finish` emit (~line 707)
- What: `await runHooks('run_end', { runId: run.state.runId, phase: run.state.phase }, { hooks: run.config.hooks, cwd: run.worktree, env: run.childEnv, exec: run.exec, signal: run.abort.signal, redact: (s) => run.redactor.text(s) })` — non-blocking; ignore `blocked` (log it if useful).
- Why: run_end is observability only; W10 owns src/hooks/** and cannot edit core.

### W10 cycle_end hook at the end of every cycle (branch ws/10-instructions)

- Where: src/core/cycle.ts, runOneCycle, next to the `cycle.end` emit (~line 699)
- What: `await runHooks('cycle_end', { task: taskId, verdict: pending.verdict, done: pending.done, cycle: run.state.cycle }, { hooks: run.config.hooks, cwd: run.worktree, env: run.childEnv, exec: run.exec, signal: run.abort.signal, redact: (s) => run.redactor.text(s) })` — non-blocking, fire-and-report only.
- Why: cycle_end is observability only; W10 owns src/hooks/** and cannot edit core.

### W10 pre_commit hook vetoes a commit (branch ws/10-instructions)

- Where: src/core/cycle.ts, stepCommit, immediately before `commitCheckpoint(...)` (~line 537)
- What: `const h = await runHooks('pre_commit', { task: task.id, cycle: run.state.cycle, files: p.changedFiles }, { hooks: run.config.hooks, cwd: run.worktree, env: run.childEnv, exec: run.exec, signal: run.abort.signal, redact: (s) => run.redactor.text(s) })` — when `h.blocked`, do not commit: route the cycle to rollback with `h.reason` as the rejection reason (append it to `p.reasons`, or force `setPhase('rollback')`) and emit an event carrying the reason so the agent sees the hook's stderr.
- Why: acceptance requires a pre_commit hook to veto a commit with its stderr fed back; W10 may not edit src/core/* or src/git/*.

### W10 pre_tool / post_tool hooks around every tool call (branch ws/10-instructions)

- Where: src/agent/loop.ts, runAgentLoop, the `for (const call of calls)` dispatch (around the `tool.run(parsed.data, deps.toolCtx)` call)
- What: before running a tool, `const h = await runHooks('pre_tool', { tool: call.name, input: summarizeInput(call.input) }, { hooks: <hooks from config>, cwd: deps.toolCtx.jail.root, env: deps.toolCtx.env, exec: deps.toolCtx.exec ?? runShell, signal: deps.toolCtx.signal })` — when `h.blocked`, push a `tool_result` with content `h.reason` (isError) instead of calling `tool.run`. After the call (success or error), `await runHooks('post_tool', { tool: call.name, isError }, …)` — never blocks. LoopDeps needs the hooks array passed in (e.g. `hooks?: OmnexxConfig['hooks']`).
- Why: only src/hooks/** is W10's; the dispatch loop itself belongs to core/W9.

### W10 instructions and skill list in the system prompt (branch ws/10-instructions)

- Where: src/core/cycle.ts, stepAct (the `systemPrompt: WORKER_SYSTEM` argument to buildCycleContext, ~line 261), text owned by src/agent/prompts.ts
- What: build `systemPrompt` as `WORKER_SYSTEM` plus two optional blocks: (1) the output of `renderInstructions(loaded)` where `loaded = await loadInstructions(run.worktree, run.worktree)` (or the task's primary directory as cwd for nested files); (2) a `# Skills` heading with one `- <name>: <description>` line per entry from `await listSkills({ repoRoot: run.worktree, env: run.childEnv })`. Skip a block when it is empty, and bump `PROMPT_VERSION` in src/agent/prompts.ts whenever the composed text changes.
- Why: the cached prompt prefix must carry repo instructions and the skill list; W10 may not edit src/agent/prompts.ts or src/core/*, so Claude wires it.

### W10 docs/config.md link to hooks (branch ws/10-instructions)

- Where: docs/config.md (the table-of-sections / key index)
- What: add a line linking [hooks.md](hooks.md); the schema is `src/config/sections/hooks.ts` (`[[hooks]]` array of tables), already merged by the sections barrel.
- Why: docs/config.md is shared; W10 owns docs/hooks.md and docs/instructions.md only.
