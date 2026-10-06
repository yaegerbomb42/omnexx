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

