# Lazy Tool Discovery

An optional mode that saves prompt tokens by sending only a compact tool index until the agent explicitly requests specific tool groups via the `request_tools` meta-tool.

## Overview

By default, Omnexx sends the full JSON schema for every tool to the provider on every request. **Lazy tool discovery** changes this behavior:

- **Full mode (default)**: All tool definitions sent every request (byte-identical to current behavior)
- **Lazy mode**: Only a compact index of tool groups is sent; full definitions are loaded on demand

## Enabling Lazy Mode

### Config File (`omnexx.toml`)

```toml
[tools]
discovery = "lazy"  # "full" (default) | "lazy"
max_loaded_groups = 10  # optional LRU cap
```

### Environment Variable

```bash
OMNEXX_TOOL_DISCOVERY=lazy omnexx run "your goal"
```

### CLI Flag

```bash
omnexx run "your goal" --tool-discovery lazy
```

## How It Works

### Tool Groups

Tools are organized into groups (from `TOOL_GROUPS` with `GROUP_PURPOSES`):

| Group     | Purpose                  | Tools                                                                                  |
| --------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `fs`      | read and edit files      | read, write_file, str_replace, multi_edit, replace_lines, outline, read_symbol, search |
| `shell`   | run commands, read logs  | bash, read_log                                                                         |
| `web`     | fetch pages, web search  | web_fetch, web_search                                                                  |
| `browser` | drive a headless browser | browser                                                                                |
| `memory`  | notes, recall, artifacts | remember, recall, context, running_context, query_artifact, repl_projection            |
| `task`    | subtasks and todo list   | task, todo                                                                             |

There is no separate `search`, `git`, or `core` group — search lives in `fs`, and core tools are distributed across groups.

### Always-Loaded Tools

These core tools are **always** fully defined, even in lazy mode (via `ALWAYS_LOADED_TOOLS`):

- `read`, `write_file`, `str_replace` — essential file operations
- `bash` — shell execution
- `search` — search (in `fs` group)
- `todo` — task tracking (in `task` group)
- `more_tools` — legacy lazy-loading meta-tool
- `request_tools` — the meta-tool for loading groups

### Compact Index Format

In lazy mode, the system prompt includes a compact index with a header line and one line per group showing load status:

```
Call request_tools({groups:[...]}) to load full definitions for a group before using its tools. Groups marked loaded are ready.
- fs (read and edit files) loaded: read, write_file, str_replace, multi_edit, replace_lines, outline, read_symbol, search
- shell (run commands, read logs) loaded: bash, read_log
- web (fetch pages, web search): web_fetch, web_search
- browser (drive a headless browser): browser
- memory (notes, recall, artifacts): remember, recall, context, running_context, query_artifact, repl_projection
- task (subtasks and todo list): task, todo
```

### The `request_tools` Meta-Tool

The agent calls this tool to load full definitions for specific groups or tools:

```json
{
  "groups": ["memory", "web"],
  "tools": ["recall", "browser"]
}
```

Response example:

```
Loaded 8 tool(s): remember, recall, context, running_context, query_artifact, repl_projection, web_fetch, web_search. Currently loaded groups: fs, shell, memory, web
```

### Auto-Loading

If the model calls a tool whose group isn't loaded, the system automatically loads that group and returns an error asking the model to retry:

> "Tool `recall` was not loaded; loaded group `memory`. Retry the call."

This avoids hard failures and lets the agent self-correct. The `tool.autoload` event is emitted with `{tool, group}`.

### Turn-Level Refresh

The tool list is **refreshed every turn** (in `src/agent/loop.ts`), so:

- `request_tools` calls take effect on the **next turn**
- Auto-loaded groups are available on the **next turn**
- The `refreshTools` function in `LoopDeps` rebuilds the tool list from the current `LoadedToolsState`

### Persistence Across Compaction

Loaded groups live on the Run as `LoadedToolsState` (in `src/tools/request-tools.ts`), which survives context compaction because it's stored on the run object, not in the conversation history.

### MCP & Ungrouped Tools

Tools not in any group (e.g., MCP server tools) are **always sent in full** — they bypass the lazy filtering entirely.

### LRU Unloading (Optional)

If `max_loaded_groups` is set, the least recently used groups are unloaded when the cap is exceeded. Core groups (`fs`, `shell`) are never unloaded.

## Token Savings

Measured numbers from the unit test (`test/unit/tools/lazy-discovery-flow.test.ts`):

| Mode                                              | Tool Schema Tokens |
| ------------------------------------------------- | ------------------ |
| Full (all built-in tools)                         | 3,800              |
| Lazy (fs+shell loaded by default, index included) | 2,706              |
| **Saved**                                         | **1,094 (~29%)**   |

Savings grow as more grouped tools remain unloaded. The more groups the agent keeps off, the more tokens saved per request.

## Metrics

Each cycle in lazy mode emits two events:

### `cycle.context` event with `toolDiscovery` field

```json
{
  "toolDiscovery": {
    "mode": "lazy",
    "loadedGroups": ["fs", "shell", "memory"],
    "fullToolsTokens": 3800,
    "lazyToolsTokens": 2156,
    "toolIndexTokens": 550,
    "omittedTokens": 1094
  }
}
```

In full mode, only `{ "mode": "full" }` is emitted.

### `tool.discovery` event with detailed token breakdown

```json
{
  "fullToolsTokens": 3800,
  "lazyToolsTokens": 2156,
  "toolIndexTokens": 550,
  "savedTokens": 1094
}
```

### `tool.autoload` event

Emitted when a tool's group is auto-loaded:

```json
{
  "tool": "recall",
  "group": "memory"
}
```

## Compatibility

- **All providers**: Works with Anthropic and OpenAI-compatible providers since filtering happens at the shared registry layer
- **Context compaction**: Loaded state persists on the Run object and survives context compaction
- **Default behavior**: When `discovery = "full"` (default), behavior is byte-identical to pre-lazy mode

## Best Practices

1. **Start with full mode** if you're unsure — it's the safe default
2. **Enable lazy mode** for long-running tasks where token budget matters
3. **Set `max_loaded_groups`** if you want to prevent unbounded group loading
4. **Monitor `savedTokens`** in telemetry to measure actual savings
