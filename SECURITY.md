# Security

Omnexx runs an LLM agent with shell access to a repository, unattended. Read [docs/safety.md](docs/safety.md) for exactly what host mode does and doesn't protect against before you run it on a machine with anything you care about.

## Reporting

This is a personal project. Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab) on `yaegerbomb42/omnexx` rather than in a public issue.

## Secrets

- Omnexx reads your Anthropic key from `OMNEXX_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY` or `~/.config/omnexx/credentials/anthropic.key` (mode 0600). It never reads Claude subscription logins, Claude Code credentials or keychains.
- The key exists only in the supervisor process. Every child process (gates, the agent's `bash` tool, workers) gets a scrubbed environment.
- A redaction filter masks known secret env values and common token formats in every event, log, patch, report, judge payload and notification.
