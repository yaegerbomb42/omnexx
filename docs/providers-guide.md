# Providers Guide

Omnexx uses a **bring-your-own-key** model. You configure one or more LLM providers, each with a chain of models for failover. The primary provider is Anthropic, but any OpenAI-compatible endpoint works (OpenRouter, Groq, Ollama, LM Studio, LiteLLM, custom gateways).

## Quick reference

| Provider   | Kind          | Example base URL                 |
| ---------- | ------------- | -------------------------------- |
| Anthropic  | Native        | `https://api.anthropic.com`      |
| OpenRouter | OpenAI-compat | `https://openrouter.ai/api/v1`   |
| Groq       | OpenAI-compat | `https://api.groq.com/openai/v1` |
| Ollama     | OpenAI-compat | `http://localhost:11434/v1`      |
| LM Studio  | OpenAI-compat | `http://localhost:1234/v1`       |
| LiteLLM    | OpenAI-compat | `http://your-litellm:4000/v1`    |

## Adding a provider interactively

```bash
omnexx providers add
```

This prompts for:

1. **Name** – a short identifier (e.g., `openrouter`, `local-ollama`)
2. **Kind** – `anthropic` or `openai-compat`
3. **Base URL** – the API endpoint
4. **API key** – stored in `~/.config/omnexx/keys/<name>` (mode 0600)
5. **Models** – a comma-separated list of model IDs for the default role chain

## Configuring via `omnexx.toml`

You can also define providers directly in your project or user config. The TOML section is `[providers.endpoints.<name>]`.

### Anthropic (native)

```toml
[providers.endpoints.anthropic]
kind = "anthropic"
# base_url defaults to https://api.anthropic.com
# api_key from env OMNEXX_ANTHROPIC_API_KEY or ~/.config/omnexx/keys/anthropic
```

### OpenRouter

```toml
[providers.endpoints.openrouter]
kind = "openai-compat"
base_url = "https://openrouter.ai/api/v1"
# api_key from env OMNEXX_OPENROUTER_API_KEY or ~/.config/omnexx/keys/openrouter
```

### Groq

```toml
[providers.endpoints.groq]
kind = "openai-compat"
base_url = "https://api.groq.com/openai/v1"
# api_key from env OMNEXX_GROQ_API_KEY or ~/.config/omnexx/keys/groq
```

### Ollama (local)

```toml
[providers.endpoints.ollama]
kind = "openai-compat"
base_url = "http://localhost:11434/v1"
# No API key needed for local Ollama
```

### LM Studio (local)

```toml
[providers.endpoints.lm-studio]
kind = "openai-compat"
base_url = "http://localhost:1234/v1"
# No API key needed for local LM Studio
```

### Custom gateway / LiteLLM proxy

```toml
[providers.endpoints.my-gateway]
kind = "openai-compat"
base_url = "http://litellm-proxy:4000/v1"
# api_key from env OMNEXX_MY_GATEWAY_API_KEY or ~/.config/omnexx/keys/my-gateway
```

## Model chains per role

Each role (planner, worker, cheap) can specify a chain of models across providers. The first available model is used; on failure or quota exhaustion, the next is tried.

```toml
[models]
planner = ["anthropic:claude-3-5-sonnet-20241022", "openrouter:anthropic/claude-3.5-sonnet"]
worker = ["anthropic:claude-3-5-haiku-20241022", "groq:llama-3.1-70b-versatile", "ollama:llama3.1:70b"]
cheap = ["groq:llama-3.1-8b-instant", "ollama:llama3.1:8b"]
```

Format: `<provider-name>:<model-id>` where provider name matches a key in `[providers.endpoints]`.

## Per-provider spend caps

```toml
[providers.endpoints.openrouter]
kind = "openai-compat"
base_url = "https://openrouter.ai/api/v1"
max_usd_per_day = 10.00
max_usd_per_run = 5.00
```

## Environment variable overrides

| Variable                   | Purpose                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `OMNEXX_ANTHROPIC_API_KEY` | Anthropic API key                                                  |
| `OMNEXX_<NAME>_API_KEY`    | Key for custom provider `<name>` (uppercase, dashes → underscores) |
| `OMNEXX_MODELS_PLANNER`    | Override planner model chain                                       |
| `OMNEXX_MODELS_WORKER`     | Override worker model chain                                        |
| `OMNEXX_MODELS_CHEAP`      | Override cheap model chain                                         |

## Listing and testing providers

```bash
# List configured providers
omnexx providers list

# Test a provider (makes a cheap API call)
omnexx providers test openrouter
```

## Tips

- **Local models**: Use Ollama or LM Studio for zero-cost development. They work great for the `cheap` role.
- **Failover chains**: Always specify at least two models per role. A quota-exhausted or rate-limited model automatically falls back to the next.
- **Cost control**: Set `max_usd_per_day` on expensive providers. Omnexx will pause and resume when the rolling 24h window clears.
- **No keys in repo**: Keys are stored in `~/.config/omnexx/keys/` (mode 0600) or via environment variables. Never commit them.
