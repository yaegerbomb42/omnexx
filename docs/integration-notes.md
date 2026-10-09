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

### W4 providers and models (branch ws/4-providers)

- Where: src/cli/run-deps.ts, function resolveRunDeps
- What: switch `resolveChain`/`costUsd` to `resolveChainLenient`/`costOf` from src/providers/profiles.ts (same names plus `price: PriceConfig | undefined`), treat `usd === undefined` as "over no USD cap" in pre-flight (token caps still apply), and show `"–"` via `formatCost` wherever a cost prints. Wrap endpoint providers with `withToolRepair` (src/providers/repair.ts) and construct `kind = "responses"` endpoints as `ResponsesProvider` (src/providers/responses.ts) and `kind = "gemini"` endpoints as `GeminiProvider` (src/providers/gemini.ts); this needs `endpointSchema` (src/config/schema.ts) to accept `kind = "openai" | "responses" | "gemini"`.
- Why: pricing-optional models, repair layer and new providers without W4 touching run-deps or schema.
- Where: src/config/schema.ts, modelsSchema
- What: add `profiles: z.record(z.string(), modelProfileSchema).default({})` (schema in src/config/sections/models-profiles.ts) so `[models.profiles."<provider>:<model>"]` parses; the CLI already reads it leniently via `loadModelProfiles` until then.
- Why: model profiles for the W3 router contract.
- Where: src/agent/loop.ts, tool-call path
- What: after `withToolRepair` fixes syntax, validate each call with `validateWithSchema(input, tool.schema)`; on failure, append one `reaskMessage(name, error, id)` user message and retry the turn once; after the retry still fails, end the turn with an error result (not the run). Record `kind` (`fixed-json`/`coerced-schema`/`re-asked`) in the `tool.call` event.
- Why: one re-ask repair for weak/local models per the W4 spec.
- Where: src/cli/program.ts, `auth` command
- What: `auth set|clear` currently calls `assertProvider` (now accepts any lowercase name) and `storeKey`/`clearKey` — no change needed beyond what W4 did in src/auth/keys.ts; keep the `readSecret` flow as is. `doctor`'s anthropic-key check is unchanged.
- Why: `omnexx auth set <any-provider>` works with no further edits.

### W5 Browser tool (branch ws/5-browser)

- Where: src/cli/commands/doctor.ts, function doctorChecks
- What: Call `checks.push(await browserDoctorCheck())` from `src/tools/extra/browser/detector.js`.
- Why: Surface missing browser automation backend (`agent-browser` or `playwright-core`) to users in `omnexx doctor`.

### W5 Browser gate runner (branch ws/5-browser)

- Where: src/verify/gates.ts, function runGate
- What: Dispatch gates with `gate.kind === 'browser'` to `runBrowserGate(gate, ctx)` from `src/verify/browser-gate.js`.
- Why: Execute browser YAML/TOML acceptance gates as first-class gates alongside command gates.

### W6 + W7 MCP client & web tools (branch ws/6-mcp-web)

- Where: `src/core/run.ts` or supervisor lifecycle teardown
- What: Call `resetMcpManager()` from `src/tools/extra/mcp.js` when a run terminates
- Why: Ensures background stdio child processes for MCP servers are cleanly stopped on run end
- Where: `test/unit/package.test.ts`, approved dependencies test
- What: Add `@modelcontextprotocol/sdk`, `@mozilla/readability`, and `linkedom` to approved runtime dependencies list (per DECISIONS.md D30 and agent prompts W6/W7)
- Why: Allow W6 and W7 approved packages in package.json dependencies without failing the package unit test

### W14 Secret Scanner in Verify / Commit path (branch ws/12-workers-safety)

- Where: `src/core/cycle.ts`, inside `stepVerify`
- What: Import `scanPatchForSecrets` from `../security/secret-scan.js`. Before approving candidate diff, run:
  ```ts
  const secScan = scanPatchForSecrets(patch, {
    allowlist: (run.config as any).security?.secret_allow ?? [],
  });
  if (!secScan.clean) {
    for (const f of secScan.findings) {
      reasons.push(`secret-scan: ${f.reason} in ${f.file}:${f.line} (${f.rule})`);
      evidence.push(
        `Committed secret detected: ${f.reason} in ${f.file}:${f.line}. Remove credentials before committing.`,
      );
    }
  }
  ```
- Why: Enforces automatic secret scanning on every candidate commit before gates/commits land, respecting `[security] secret_allow`.

### W12 Worker Adapters Wiring in run-deps and cycle (branch ws/12-workers-safety)

- Where: `src/cli/run-deps.ts` and `src/cli/commands/doctor.ts`
- What: Replace the temporary `throw new UsageError('...adapters not available until M3')` guard with `createWorkerAdapter(id, w)` from `../workers/adapters/index.js`.
- Why: Allows real worker backends to be enabled when configured by the user.

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
