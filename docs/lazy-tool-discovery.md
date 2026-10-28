# Lazy Tool Discovery

An optional mode that saves prompt tokens by sending only a compact tool index until the agent explicitly requests specific tool groups via the `request_tools` meta-tool.

## Overview

By default, Omnexx sends the full JSON schema for every tool to the provider on every request. This can consume thousands of tokens, especially with many tools loaded. **Lazy tool discovery** changes this behavior:

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

Tools are organized into groups:

| Group | Tools | Description |
|-------|-------|-------------|
| `fs` | read, write_file, str_replace, multi_edit, replace_lines, outline, read_symbol, search | File system operations |
| `shell` | bash, read_log | Shell commands |
| `search` | search | Search tools |
| `web` | web_fetch, web_search | Web browsing |
| `browser` | browser | Browser automation |
| `memory` | remember, recall, context, running_context, query_artifact, repl_projection | Notes & memory |
| `task` | task, todo | Sub-agents & task management |

### Always-Loaded Tools

These core tools are **always** fully defined, even in lazy mode:

- `read`, `write_file`, `str_replace` - essential file operations
- `bash` - shell execution
- `search` - search
- `todo` - task tracking
- `more_tools` - legacy lazy-loading meta-tool
- `request_tools` - the new meta-tool for loading groups

### Compact Index Format

In lazy mode, the system prompt includes a compact index like:

```
- fs: Read and edit files — read, write_file, str_replace, multi_edit, replace_lines, outline, read_symbol, search
- shell: Run shell commands — bash, read_log
- search: Search files — search
- web: Fetch and search web — web_fetch, web_search
- browser: Browser automation — browser
- memory: Notes and memory — remember, recall, context, running_context, query_artifact, repl_projection
- task: Sub-agents and tasks — task, todo
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

This avoids hard failures and lets the agent self-correct.

### LRU Unloading (Optional)

If `max_loaded_groups` is set, the least recently used groups are unloaded when the cap is exceeded. Core groups (`fs`, `shell`) are never unloaded.

## Token Savings

Typical savings (approximate):

| Mode | Tool Schema Tokens |
|------|-------------------|
| Full | ~8,000–12,000 tokens |
| Lazy (index only) | ~500–800 tokens |
| Lazy (with 3 groups loaded) | ~2,000–3,000 tokens |

The exact savings depend on your tool set and how many groups the agent loads.

## Metrics

Each cycle in lazy mode emits a `cycle.context` event with a `toolDiscovery` field:

```json
{
  "toolDiscovery": {
    "mode": "lazy",
    "loadedGroups": ["fs", "shell", "memory"],
    "fullToolsTokens": 9421,
    "lazyToolsTokens": 2156,
    "toolIndexTokens": 412,
    "omittedTokens": 6853
  }
}
```

- `fullToolsTokens`: Tokens if all tools were sent
- `lazyToolsTokens`: Tokens for currently loaded tools
- `toolIndexTokens`: Tokens for the compact index
- `omittedTokens`: Estimated savings (`fullToolsTokens - lazyToolsTokens - toolIndexTokens`)

## Compatibility

- **All providers**: Works with Anthropic and OpenAI-compatible providers since filtering happens at the shared registry layer
- **Context compaction**: Loaded state persists on the Run object and survives context compaction
- **Default behavior**: When `discovery = "full"` (default), behavior is byte-identical to pre-lazy mode

## Best Practices

1. **Start with full mode** if you're unsure - it's the safe default
2. **Enable lazy mode** for long-running tasks where token budget matters
3. **Set `max_loaded_groups`** if you want to prevent unbounded group loading
4. **Monitor `omittedTokens`** in telemetry to measure actual savings