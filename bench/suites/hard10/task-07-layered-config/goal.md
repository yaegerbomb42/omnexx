# Task: Layered, Validated Configuration

Today `loadConfig(file)` in `src/load.ts` merges one JSON file over the defaults and throws on the
first problem. Replace it with a layered loader. New signature (update the existing test):

```ts
loadConfig(opts: { files?: string[]; env?: Record<string, string | undefined>; argv?: string[] }):
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; errors: { path: string; message: string }[] }
```

**Layers**, lowest to highest precedence: schema defaults, then each JSON file in `files` in
order, then `env`, then `argv`. Objects deep-merge; arrays and scalars replace.

**Env.** Only variables starting with `APP_` are read. The rest of the name is the config path
with `__` between segments and `SNAKE_CASE` for camelCase keys: `APP_SERVER__PORT` is
`server.port`, `APP_DB__POOL_SIZE` is `db.poolSize`, `APP_FEATURES` is `features`. Matching is
case-insensitive. Env values are strings and are coerced by the schema type: `integer` (decimal
digits only, optional leading `-`), `boolean` (`true`/`false`/`1`/`0`, case-insensitive),
`string[]` (comma-separated, items trimmed, empty items dropped), `enum`/`string` as is.

**Argv.** `--server.port=9000` sets a path (value coerced like env). A bare `--log.json` sets a
boolean to `true` and `--no-log.json` sets it to `false`. Arguments not starting with `--` are
ignored.

**Validation.** Collect every problem instead of stopping at the first, and report each with the
dotted config `path` it concerns (for a file that cannot be read or is not valid JSON, `path` is
the file path). Problems: unknown keys in a file (path of the unknown key, e.g. `server.prot`), an
unknown `APP_` variable or `--` option (path is what it would map to, e.g. `server.prot`), a
value of the wrong type (JSON files must already hold the right JSON type: no coercion from
strings), integers outside `min`/`max` or not whole, enum values not in `values`, `string[]`
holding non-strings, a missing required key. Messages are free text. When there are no
problems, return the full config as nested objects (`{ server: { port, host }, log: {...},
db: {...}, features: [...] }`), with nothing but schema keys.

Keep `src/schema.ts` as the single source of truth (a new schema key must work without touching
the loader). Split the code into sensible modules and add tests.

## Success Criteria

- `npm test` passes (Node >= 22.18 runs the `.ts` files directly; no build step)
- `loadConfig` behaves as specified above
