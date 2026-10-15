# Model Context Protocol (MCP) Client

Omnexx supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), allowing agents to connect to external tool servers over stdio or Streamable HTTP. (Old SSE-only endpoints are not supported; most servers also offer a `/mcp` streamable endpoint.)

## Quick setup

```bash
omnexx mcp gallery               # popular servers: filesystem, github, playwright, postgres, …
omnexx mcp gallery filesystem    # add one (asks for what it needs, or --set KEY=VALUE)
omnexx mcp add playwright        # by name, from the official MCP registry
omnexx mcp search github         # ✓ marks a known publisher
omnexx mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/notes
omnexx mcp add linear --url https://mcp.linear.app/mcp   # asks for a browser sign-in if needed
omnexx mcp import                # from Claude Code, Claude Desktop, Cursor, VS Code, Windsurf
omnexx mcp import --json cfg.json  # a pasted {"mcpServers": …} block ("-" reads stdin)
omnexx mcp list                  # status, tool count and context cost of each server
```

Every add starts the server once, so a broken setup shows up right away: a missing `npx`/`uvx`/
`docker` gets an install hint, a remote server that answers 401 is switched to OAuth and
`omnexx mcp login <name>` signs you in (in a terminal it starts right away), and a server that
exits prints the tail of its stderr. `omnexx mcp logs <name>` shows its whole output.

### Status, tool cost, on/off and allow-lists

Every tool a server offers costs context tokens on every request (its name, description and input
schema are sent with each one). `omnexx mcp list` starts each server and shows:

```
  ● playwright           21 tools ~4.2k tok     stdio npx -y @playwright/mcp@latest
  ✗ postgres             failed                 stdio npx -y @modelcontextprotocol/server-postgres …
      MCP server "postgres" failed to start: it exited during startup
  ○ notion               disabled               http  https://mcp.notion.com/mcp
```

- `omnexx mcp disable <name>` / `enable <name>`: keep the setup but stop starting it
  (`enabled = false` in its table). A project server (omnexx.toml or `.mcp.json`) gets a user
  override table instead.
- `omnexx mcp allow <name> 'browser_*' read_file`: only these tools reach the model;
  `omnexx mcp allow <name>` with no globs allows all again.

### VS Code

Settings (the gear) → **MCP servers**: each server with a status dot (green running, red failed,
hollow disabled), its tool count and approximate tokens, an on/off switch, **Tools** (tick which
tools the model sees, with the cost of each), **Logs**, **Sign in** for a remote server that needs
it, and **Remove**. **Add server** opens a searchable gallery of popular servers plus a search of
the official MCP registry (one click, then a short form for any required value), a command, a URL,
or **Paste JSON** (an `mcpServers` block from Claude Desktop, Cursor, Windsurf or VS Code).
**Import from Claude / Cursor / VS Code** lists what the other tools have and imports the ones you
tick. Tokens always go to the private secrets file.

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

In the TUI: `/mcp` shows the same status list; `/mcp gallery [id]`, `/mcp add <name>`,
`/mcp enable|disable <name>`, `/mcp allow <name> <globs>`, `/mcp search <q>`, `/mcp import`.

### Or just ask omnexx

The agent has two tools for this: `integrations_search` (registry search, or the skills available
here) and `integrations_install` (an MCP server from the registry, or skills from a path or git
URL). Say "set up the Playwright MCP server" or "add the skills from <git url>" in chat. Who
approves an install:

| Where                                       | What happens                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Chat                                        | It shows publisher and what will run, and asks you (`y/N`)                                         |
| Chat in yolo mode, or `policy.auto_approve` | Installs without asking (the feed shows what it installed)                                         |
| Unattended run without `auto_approve`       | Installs nothing; the suggestion and the exact command go to REPORT.md under "Needs your decision" |

Settings a server needs (a token) are never guessed: the agent asks you for them or points you at
`omnexx mcp add … --set`. New MCP tools are available from the next cycle of a run, or in a new
chat. Planners and read-only helpers don't get these tools.

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
url = "https://mcp.internal.example/mcp"
headers_env = { Authorization = "SERVICE_TOKEN" } # Header values: an env var name, secret:<KEY>, or a literal
allow_tools = ["query_*"]
timeout = "1m"                  # how long it may take to start (npx downloads count)
enabled = false                 # keep it configured but never start it
```

Omnexx also automatically discovers and reads `.mcp.json` (Claude Code format) in the repository root. Any server defined in `omnexx.toml` takes precedence over `.mcp.json`.

## Lazy mounting (default)

A tool's name, description and input schema are sent with every request, so 80 MCP tools cost
~20–30k tokens per turn whether or not they are used. By default (`[mcp] mount = "lazy"`) the
model sees two small tools instead:

- `mcp(server)`: its description lists the installed servers, one line each (name, tool count,
  the first tool names). Calling it **mounts** the server: the result holds that server's tool
  names, descriptions and input schemas.
- `mcp_call(server, tool, args)`: calls a tool of a mounted server. The args are checked against
  the tool's schema first; a mismatch comes back with the problem and the schema.

A mounted server stays mounted for the whole run or chat: the list is kept in the run's
`mcp-mounted.json`, so it survives compaction and later cycles, and it records which servers a run
used. After compaction the model can mount a server again to see its schemas again.

**Why schemas go in the conversation and not the tool list.** Providers cache the prompt prefix in
order: tools, then the system prompt, then the messages. Adding tools when a server is mounted, even
at the end of the tool list, changes the tools block and so invalidates everything after it on
Anthropic (where tools come first) and on OpenAI-compatible providers (whose automatic prefix cache
also starts with the tools). With `mcp` and `mcp_call` the tool list is byte-identical for the whole
session; a mounted server's schemas arrive once as a tool result in the tail and are cached from
then on like any other turn.

Measured on four fake servers of 20 realistic tools each (`test/unit/mcp/lazy-mount.test.ts`):
~29k tool-schema tokens per request eager, ~450 lazy (98% less); a mounted server costs its
schemas once (~7k for 20 tools), not on every request.

**Eager.** `mount = "eager"`, or lazy mode when all MCP tools together cost fewer than
`eager_under_tokens` (default 3000), sends the tools up front as before:

- ≤ 20 tools: each one directly, named `mcp__<server>__<tool>`.
- \> 20 tools: **search mode**, `mcp_search(query)` (returns matching tools with schemas) and
  `mcp_call(tool, args)` (by its namespaced name).

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

# Add a remote (streamable HTTP) server; --set Authorization=<token> for a token
omnexx mcp add remote-api --url https://mcp.example.com/mcp
omnexx mcp login remote-api      # browser sign-in (OAuth) when it needs one

# List servers with status, tool count and context cost (--quick: don't start them)
omnexx mcp list

# Switch off / on, limit tools, see output
omnexx mcp disable local-fs
omnexx mcp allow local-fs read_file list_directory
omnexx mcp logs local-fs

# Test connectivity and inspect discovered tools
omnexx mcp test local-fs

# Remove a server
omnexx mcp remove local-fs
```
