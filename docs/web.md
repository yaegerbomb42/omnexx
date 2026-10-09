# Web Tools: Fetch & Search

Omnexx provides built-in tools for fetching web pages and searching the web.

## Configuration

Web tools are configured under the `[web]` section of `omnexx.toml`:

```toml
[web]
allow = ["*"]                 # Allowed host glob patterns (default "*")
deny = ["internal.lan"]       # Denied host glob patterns
fetch_timeout = "15s"         # Timeout for fetching pages
max_fetch_bytes = 5242880     # Max response size (default 5 MB)

search = "brave"              # Search backend: "brave" | "tavily" | "searxng" | "exa"
search_key_env = "BRAVE_KEY"  # Optional custom env var for API key
search_url = "https://..."    # SearXNG instance URL if using searxng backend
search_timeout = "15s"
```

## `web_fetch`

Fetches web pages via HTTP GET, converts HTML into clean Markdown using LinkeDOM and Mozilla Readability, and trims results to 8,000 tokens.

- **Robots.txt**: Automatically checks and respects `robots.txt` disallow rules.
- **Caching**: Responses are cached in-memory per run to eliminate duplicate network requests.
- **Safety**: Rejects disallowed hosts and payload bodies $> 5\text{ MB}$.

Schema:

```json
{
  "url": "https://example.com/docs",
  "maxTokens": 8000
}
```

## `web_search`

Searches the web via supported search engines:

- **Brave Search** (`BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY`)
- **Tavily** (`TAVILY_API_KEY`)
- **Exa AI** (`EXA_API_KEY`)
- **SearXNG** (`SEARXNG_URL` or `[web] search_url`)

_Note:_ If `[web] search` is not configured, the `web_search` tool is not registered in the model prompt.

Schema:

```json
{
  "query": "vitest mocking guide",
  "n": 5
}
```
