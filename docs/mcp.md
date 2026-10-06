# Model Context Protocol (MCP) Client

Omnexx supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), allowing agents to connect to external tool servers over stdio or Streamable HTTP/SSE.

## Configuration

MCP servers can be configured in your `omnexx.toml` or user configuration `~/.config/omnexx/config.toml`:

```toml
[mcp.servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]          # List of env-var names to forward
allow_tools = ["*"]             # Glob list of allowed tool names (default "*")
timeout = "30s"

[mcp.servers.remote_service]
url = "https://mcp.internal.example/sse"
headers_env = { Authorization = "SERVICE_TOKEN" } # Headers mapped to env var names
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
