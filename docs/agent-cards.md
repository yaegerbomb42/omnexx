# Agent cards

Named agents omnexx can hand work to with the `agent` tool. Two kinds:

- **Local cards**: Markdown files in Claude Code's subagent format, run as read-only helpers with
  their own instructions and a fresh context (like `task`, but with a role you wrote).
- **Remote agents**: other services that speak [A2A](https://a2a-protocol.org) (Agent2Agent),
  reached over HTTP.

The `agent` tool's description lists every agent available, so the model knows whom it can ask.
It works in chat and in long runs; planners and helpers don't get it (no helpers of helpers).

## Local cards

```markdown
---
name: security-reviewer
description: Reviews a diff for injection, secrets and unsafe defaults
tools: Read, Grep, Glob
---

You are a security reviewer. For the change you're given, list concrete risks with file and line…
```

They're read in place (later folders win on a name clash):

1. Claude Code's `~/.claude/agents` (when `[agents] import_claude`, on by default)
2. every folder in `[agents] dirs`
3. `~/.config/omnexx/agents`
4. the repo's `.claude/agents` (when `import_claude`), then `.omnexx/agents`

`tools` (optional) narrows what the helper gets. Claude Code names are mapped (`Read` → read,
`Grep`/`Glob` → search, `WebFetch` → web_fetch, `WebSearch` → web_search, `Bash` → bash); the
helper is always read-only, whatever the card asks for. `model` is ignored for now: helpers run
on the run's (or chat's) model.

## Remote A2A agents

```bash
omnexx agent-cards add https://agent.example.com            # reads /.well-known/agent-card.json
omnexx agent-cards add https://agent.example.com --header "Authorization=Bearer …"
```

This writes `[agents.remote.<name>]` with the URL; headers go to the 0600 secrets file and the
config says `secret:<KEY>`. Omnexx speaks A2A v1.0 (`SendMessage`, `A2A-Version: 1.0`) and falls
back to v0.3 (`message/send`) when a server refuses the new form. Replies are capped and handed to
the model marked as untrusted text: treat a remote agent like a web page, not like an instruction.

## Commands

| Command                              | What it does                                 |
| ------------------------------------ | -------------------------------------------- |
| `omnexx agent-cards list` (`/cards`) | every local card and remote agent            |
| `omnexx agent-cards add <url>`       | add a remote A2A agent from its card         |
| `omnexx agent-cards remove <name>`   | remove a remote agent and its stored headers |
| `omnexx agent-cards import`          | show the Claude Code agents in use           |
