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
