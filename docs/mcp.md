# Model Context Protocol (MCP) Client

Omnexx supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), allowing agents to connect to external tool servers over stdio or Streamable HTTP/SSE.

## Quick setup

```bash
omnexx mcp add playwright        # by name, from the official MCP registry
omnexx mcp search github         # ✓ marks a known publisher
omnexx mcp import                # servers you set up in Claude Code, Claude Desktop or Cursor
```

`omnexx mcp add <name>` with no command looks the name up in the
[official MCP registry](https://registry.modelcontextprotocol.io) and shows who publishes it, what
will run (pinned to the listed version) and what it needs, then asks before writing anything
(`--yes` skips the question; `--pick <registry name>` chooses among several matches). Anyone can
publish to the registry, so look-alikes exist: known publishers (Microsoft, GitHub, Google,
Anthropic, the MCP reference servers) are ranked first and marked `✓`; anything else is flagged.
It runs a package with `npx` (npm) or `uvx` (PyPI), connects to a remote endpoint, or as a last
resort runs a container with `docker`.

Settings a server needs (an API token, a header) are asked for, or passed with
`--set KEY=VALUE`. They go to a private `mcp-secrets.json` (mode 0600) next to `config.toml`, and
the config refers to them as `secret:<KEY>`. `omnexx mcp import` does the same with the raw values
in other tools' configs, so tokens never land in `config.toml`. Every add, import and remove edits
only that server's table: comments and the rest of your config stay as you wrote them.

In the TUI: `/mcp`, `/mcp add <name>`, `/mcp search <q>`, `/mcp import`.

## Configuration

MCP servers can be configured in your `omnexx.toml` or user configuration `~/.config/omnexx/config.toml`:

```toml
[mcp.servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]          # Env var names to forward, or { KEY = "ENV_NAME" | "secret:KEY" }
allow_tools = ["*"]             # Glob list of allowed tool names (default "*")
timeout = "30s"

[mcp.servers.remote_service]
url = "https://mcp.internal.example/sse"
headers_env = { Authorization = "SERVICE_TOKEN" } # Header values: an env var name, secret:<KEY>, or a literal
allow_tools = ["query_*"]
timeout = "1m"
```

Omnexx also automatically discovers and reads `.mcp.json` (Claude Code format) in the repository root. Any server defined in `omnexx.toml` takes precedence over `.mcp.json`.

## Tool Exposure & Search Mode

- When $\le 20$ MCP tools are discovered across all configured servers, omnexx exposes each tool directly with the namespace `mcp__<server>__<tool>`.
- When $> 20$ MCP tools are discovered, omnexx automatically switches to **Search Mode** to preserve prompt cache and keep the prompt prefix small. It exposes:
  - `mcp_search(query)`: searches tools by name or description and returns schemas.
  - `mcp_call(tool, args)`: invokes a specific MCP tool by its namespaced name.

## Security & Reliability

- **Small environment**: a stdio server gets only `PATH`, `HOME`, locale, temp and proxy
  settings, plus what its `env` names, so a third-party server never sees every API key in your
  shell. Set `inherit_env = true` on a server to give it your whole environment.
- **Secret Redaction**: All tool results pass through the Omnexx redactor filter before being returned to the model or recorded in event logs.
- **Token Caps**: Output is capped and deterministically trimmed to 8,000 tokens.
- **Auto-Restart**: If a stdio MCP server crashes, Omnexx attempts a single automatic reconnection and retry before failing the tool call.

## CLI Commands

```bash
# Add a stdio server
omnexx mcp add local-fs -- npx -y @modelcontextprotocol/server-filesystem /path/to/dir

# Add an HTTP / SSE server
omnexx mcp add remote-api --url https://mcp.example.com/sse

# List configured servers
omnexx mcp list

# Test connectivity and inspect discovered tools
omnexx mcp test local-fs

# Remove a server
omnexx mcp remove local-fs
```
