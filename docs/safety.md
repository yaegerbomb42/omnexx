# Safety: what host mode does and doesn't protect against

Omnexx gives an LLM a shell in your repository and leaves it alone for hours. There are two modes: `sandbox = "host"` (default) and `sandbox = "docker"`. This page is mostly about host mode; see the end for docker mode.

## What is enforced

- **Isolation from your checkout.** All work happens in a separate git worktree on `omnexx/<runId>`. Your working tree, index, HEAD and `main` are never touched (an integration test asserts `git status` and HEAD before, during and after a run). Nothing is pushed unless you set `git.push = "branch"`, and then only `omnexx/*`, never with force.
- **Path jail for file tools.** `read`, `write_file`, `str_replace` and friends resolve the real path of every argument and refuse anything outside the worktree, including through symlinks and on case-insensitive filesystems. They also refuse credential-looking files (`.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.netrc`, `.ssh/`, `.aws/`, `.git/` internals) inside the worktree.
- **Command policy for `bash`.** The command is parsed (shell-quote), split on `;`, `&&`, `||` and pipes, and each command is checked. Denied: `sudo`/`su`, `ssh`/`scp`/`rsync`/`nc`, `docker`, `kill`/`pkill`, `crontab`/`launchctl`/`systemctl`, `eval`/`exec`/`source`, `gh`, every `git` subcommand except read-only ones, `npm|pnpm|yarn publish` and friends, `curl`/`wget` (unless `allow_network`; never piped into a shell), command and process substitution, references to secret-looking variables, arguments that look like credential paths, and writes (redirections, `cp`, `mv`, `rm`, `tee`, `sed -i`, `dd of=`, …) outside the worktree or the run's own scratch dir. Shells with `-c` are checked recursively. Refusals are logged as `tool.denied`.
- **No keys in child processes.** Gates, checks, the `bash` tool and workers run with a minimal allow-listed environment; anything whose name looks like a secret is dropped even if you pass it through. The API key exists only in the supervisor.
- **Secret scanner on every candidate commit.** Every candidate patch is scanned before commit using token regexes and Shannon entropy detection on added lines (`src/security/secret-scan.ts`). Commits attempting to introduce credentials are rejected and rolled back. Specific file paths can be exempted via `[security] secret_allow = ["path-glob"]`.
- **Redaction everywhere.** Events, logs, saved patches (credential files are dropped from them), progress, the report, judge payloads and ntfy pushes go through the redaction filter. A test plants a corpus of fake secrets in the env and in a `.env` file, runs a hostile scripted agent, and greps every file Omnexx wrote: zero hits.
- **Anti-cheat and the ratchet** stop the most common "make the checks pass" shortcuts (see [architecture.md](architecture.md)).

## Threat Model: Extended Tooling & Adapters

### 1. Browser Tool

- **Threat:** Browser sessions could be weaponized to execute arbitrary JavaScript (`eval` / `execute_script`) against external or local endpoints, access sensitive local services, or leak DOM data.
- **Mitigation:**
  - Browser evaluation (`eval`, `execute_script`) is disabled by default (`checkBrowserToolPolicy()`).
  - Restrict browser navigation to allowed hosts (`[browser] allow = ["localhost", "127.0.0.1", "*.local"]`).
  - Output trees and screenshots are scrubbed and size-capped.

### 2. Model Context Protocol (MCP) Clients

- **Threat:** External MCP servers may expose destructive operations (e.g. `delete_file`, `drop_database`, remote modifications) that bypass local command policies.
- **Mitigation:**
  - MCP tools tagged as `destructive` require explicit policy approval (`checkMcpToolPolicy()`). Unapproved calls are rejected.
  - Stdio MCP server arguments and environments only forward explicit variable names, never hardcoded credential values.
  - Results are redacted and capped to 8k tokens.

### 3. Web Tools (Fetch & Search)

- **Threat:** Uncontrolled egress or data exfiltration via web fetch/search tools, SSRF into internal network resources.
- **Mitigation:**
  - `web_fetch` enforces host allowlists/denylists, robots.txt compliance, 5 MB payload caps, and request timeouts.
  - No secret headers or environment secrets are sent over external fetch requests.

### 4. Worker Backends (Claude Code, Codex, Aider, OpenCode, Cline, etc.)

- **Threat:** Third-party coding harnesses use their own execution loops and auto-approval modes, which could modify repo git history, push commits to remote repositories, or read credentials from the parent supervisor.
- **Mitigation:**
  - Workers run strictly in temporary isolated worktrees created on throwaway branches from `lastGreen`, never in the primary repo root (`checkWorkerWorktreePolicy()`).
  - The worker environment is completely scrubbed of supervisor secrets. Omnexx never reads or copies the tool's private credentials.
  - Git push is neutered via `GIT_CONFIG_COUNT` overrides pointing push URLs to nonexistent schemes.
  - Ref-tamper checks compare `git for-each-ref` before and after; any unexpected ref change immediately disqualifies and disables the worker for the run.
  - The worker's output is treated strictly as a candidate patch judged by gates, ratchet, anti-cheat, and secret scanner.

## What host mode does NOT protect against

- **Interpreters.** `node -e`, `python -c`, a test file, a `package.json` script, a `Makefile`: any code the agent writes and then runs (for example as part of a gate) runs as your user with your permissions. The command policy inspects the shell command, not what a program does. A determined or confused agent can read files outside the repo, make network calls or delete things through code it writes and executes.
- **Your home directory.** `HOME` is kept so tools find their caches, which also means tools can read config in `~` (an `.npmrc` with a token, for example) when invoked through a script.
- **Network.** There's no egress filter in host mode. Gates and setup commands (`npm ci`) need the network, and code the agent runs can use it.
- **Resource limits.** On Linux the service unit sets `Nice=10` and optional `CPUQuota`/`MemoryMax`; a foreground run has no limits.
- **The policy is a list.** It blocks the known-dangerous shapes. It is not a sandbox.

For unattended runs on a machine you care about, use `sandbox = "docker"` (below) or a dedicated user or VM.

## Docker mode

With `sandbox = "docker"`, every agent `bash` call, gate, check and setup command runs in one container per run: your uid/gid, `--cap-drop ALL`, `no-new-privileges`, read-only root with a tmpfs `/tmp`, CPU/memory/pid limits, and only the worktree and the run's scratch dir mounted read-write (the repo's `.git` read-only). Code the agent writes can no longer read your home directory or write outside the worktree. A timeout kills the process group inside the container. `network = "none"` removes network access entirely; the default `"bridge"` keeps it (needed for `npm ci` and similar).
