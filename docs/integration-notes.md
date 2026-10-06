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
