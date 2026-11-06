# Long Task: PR #144 — MCP servers made easy

Starting at the parent commit of PR #144 (`36c5f8f`), re-implement the MCP (Model Context Protocol) server management feature:

The agent should implement:

1. MCP server status display in the UI
2. MCP server gallery with predefined server configurations
3. MCP server toggles (enable/disable individual servers)
4. VS Code integration section for MCP servers

The agent's goal: implement MCP server discovery, connection management, status monitoring, and UI integration so users can easily add and manage MCP servers.

Hidden tests (from PR #144) verify:

- MCP server connections work correctly
- Server status is accurately reported
- Gallery configurations load properly
- Toggle state persists correctly

## Success Criteria

- All hidden tests from PR #144 pass
- Repo's existing test suite passes
- MCP servers can be added, enabled, disabled, and monitored
