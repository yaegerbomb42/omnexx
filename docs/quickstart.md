# Quickstart

Get up and running with omnexx in three commands.

## Prerequisites

- Node.js ≥ 22
- Git
- An Anthropic API key (or an OpenAI-compatible endpoint)

## Install

```bash
npm i -g omnexx
```

Verify the installation:

```bash
omnexx --version && omnexx doctor
```

## Configure providers

Add your Anthropic API key (or configure an OpenAI-compatible endpoint):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# Or use the built-in auth store:
# omnexx auth set anthropic
```

You can also add custom OpenAI-compatible providers (OpenRouter, Groq, Ollama, LM Studio, etc.):

```bash
omnexx providers add
```

This interactive command will guide you through adding a provider with a name, base URL, and model.

## Initialize a project

Navigate to a repository with tests (npm, pnpm, yarn, or bun) and run:

```bash
cd your-repo
omnexx init
```

This detects your package manager, test/lint/typecheck scripts, and creates an `omnexx.toml` with sensible defaults.

## Run your first task

```bash
# Plan only (dry run)
omnexx run --plan-only "Add a README to the project"

# Detached run with a budget
omnexx run --detach --budget 5 --hours 2 "Refactor the authentication module to use TypeScript strict mode"
```

## Monitor progress

```bash
# Check status
omnexx status

# Follow logs
omnexx logs -f

# View the plan
omnexx plan
```

## Get the morning-after report

```bash
omnexx report
```

This writes `REPORT.md` with the outcome, plan tree, changes, test deltas, spend, and decisions needed from you.

## Next steps

- Read the [Providers Guide](providers-guide.md) for advanced provider configuration
- Read [Why omnexx?](why-omnexx.md) for the design philosophy
- See [Configuration](config.md) for all `omnexx.toml` options
