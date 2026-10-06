# Providers and models (W4)

Any OpenAI-compatible endpoint works: OpenAI, OpenRouter, Groq, DeepSeek,
Together, Fireworks, Mistral, Gemini (via its OpenAI-compat or native endpoint),
xAI, Ollama, LM Studio, vLLM, LiteLLM, or a custom gateway. Model refs are
`"<provider>:<alias-or-id>"` (e.g. `groq:llama-3.3-70b-versatile`).

## Quick start (no TOML editing)

```sh
omnexx providers add groq          # interactive, or: --base-url URL --key-env VAR [--free]
omnexx providers list
omnexx models list --remote --provider groq
omnexx models test groq:<id>
omnexx auth set groq               # stores the key in a 0600 file
```

`providers add` appends one `[providers.endpoints.<name>]` block to
`~/.config/omnexx/config.toml` (comments elsewhere are untouched; it refuses
when the name exists) and then runs a 1-token test call. `providers list`,
`providers remove <name>` and `providers test <name>` manage and verify
endpoints. `models add <provider:model> [--tags a,b] [--ctx 200k] [--vision]
[--no-tools] [--speed fast] [--quality high]`, `models list [--provider x]
[--remote]`, `models remove` and `models test <ref>` manage per-model profiles
under `[models.profiles."<provider>:<model>"]`.

## Keys

Lookup order per provider: `OMNEXX_<NAME>_API_KEY`, the endpoint's
`api_key_env`, then `<configHome>/credentials/<name>.key` (mode 0600).
`omnexx auth set|clear <any-provider>` writes/removes that file. Env always
wins. Anthropic keeps its historical pair (`OMNEXX_ANTHROPIC_API_KEY`, then
`ANTHROPIC_API_KEY`). Keys are never logged; doctor masks them.

## Endpoint kinds

- `kind = "openai"` (default): Chat Completions at `{base_url}/chat/completions`;
  discovery via `GET {base_url}/models` (or Ollama `/api/tags` where served).
- `kind = "responses"`: OpenAI Responses API at `{base_url}/responses`
  (OpenAI, Azure OpenAI, compatible gateways).
- Native Gemini (`generateContent` + function calling) is available in code
  (`GeminiProvider`); wiring a `kind = "gemini"` endpoint needs the
  integrator (see docs/integration-notes.md, W4).

## Pricing is optional

Unknown prices no longer throw. Tokens are always counted; cost is `undefined`,
budgets fall back to token caps, and display shows `"\u2013"`. Add
`[pricing.<alias>]` (`id`, per-MTok `input`/`output`/`cache_*` rates) to price a
model. Use the lenient resolver (`resolveModelLenient` in
`src/providers/profiles.ts`) so unpriced models flow through the loop and the
router; see the INTEGRATION note for switching run-deps over.

## Profiles (router contract)

`[models.profiles."<provider>:<model>"]`: `tags` (string[]), `context` (int
tokens), `tools` (bool, default true), `vision` (bool, default false),
`speed` (`fast|normal|slow`), `quality` (`low|mid|high`). `listProfiles`
returns them sorted for a byte-stable prompt prefix. Merging `profiles` into
the core `models` schema needs the integrator (strictObject rejects it today).

## Tool-call repair

Weak/local models get a repair pass: trailing commas, single quotes, code
fences, stringified JSON args are fixed; values coerce toward the tool's zod
schema (`"42"` -> `42`). `withToolRepair(provider)` applies the syntax pass.
The single re-ask with the validation error, then failing the turn (not the
run), needs a loop hook (see the INTEGRATION note).
