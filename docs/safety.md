# Safety: what host mode does and doesn't protect against

Omnexx gives an LLM a shell in your repository and leaves it alone for hours. In this build the only mode is `sandbox = "host"`. Be clear about what that means.

## What is enforced

- **Isolation from your checkout.** All work happens in a separate git worktree on `omnexx/<runId>`. Your working tree, index, HEAD and `main` are never touched (an integration test asserts `git status` and HEAD before, during and after a run). Nothing is pushed unless you set `git.push = "branch"`, and then only `omnexx/*`, never with force.
- **Path jail for file tools.** `read`, `write_file`, `str_replace` and friends resolve the real path of every argument and refuse anything outside the worktree, including through symlinks and on case-insensitive filesystems. They also refuse credential-looking files (`.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.netrc`, `.ssh/`, `.aws/`, `.git/` internals) inside the worktree.
- **Command policy for `bash`.** The command is parsed (shell-quote), split on `;`, `&&`, `||` and pipes, and each command is checked. Denied: `sudo`/`su`, `ssh`/`scp`/`rsync`/`nc`, `docker`, `kill`/`pkill`, `crontab`/`launchctl`/`systemctl`, `eval`/`exec`/`source`, `gh`, every `git` subcommand except read-only ones, `npm|pnpm|yarn publish` and friends, `curl`/`wget` (unless `allow_network`; never piped into a shell), command and process substitution, references to secret-looking variables, arguments that look like credential paths, and writes (redirections, `cp`, `mv`, `rm`, `tee`, `sed -i`, `dd of=`, …) outside the worktree or the run's own scratch dir. Shells with `-c` are checked recursively. Refusals are logged as `tool.denied`.
- **No keys in child processes.** Gates, checks, the `bash` tool and workers run with a minimal allow-listed environment; anything whose name looks like a secret is dropped even if you pass it through. The API key exists only in the supervisor.
- **Redaction everywhere.** Events, logs, saved patches (credential files are dropped from them), progress, the report, judge payloads and ntfy pushes go through the redaction filter. A test plants a corpus of fake secrets in the env and in a `.env` file, runs a hostile scripted agent, and greps every file Omnexx wrote: zero hits.
- **Anti-cheat and the ratchet** stop the most common "make the checks pass" shortcuts (see [architecture.md](architecture.md)).

## What host mode does NOT protect against

- **Interpreters.** `node -e`, `python -c`, a test file, a `package.json` script, a `Makefile`: any code the agent writes and then runs (for example as part of a gate) runs as your user with your permissions. The command policy inspects the shell command, not what a program does. A determined or confused agent can read files outside the repo, make network calls or delete things through code it writes and executes.
- **Your home directory.** `HOME` is kept so tools find their caches, which also means tools can read config in `~` (an `.npmrc` with a token, for example) when invoked through a script.
- **Network.** There's no egress filter in host mode. Gates and setup commands (`npm ci`) need the network, and code the agent runs can use it.
- **Resource limits.** On Linux the service unit sets `Nice=10` and optional `CPUQuota`/`MemoryMax`; a foreground run has no limits.
- **The policy is a list.** It blocks the known-dangerous shapes. It is not a sandbox.

For unattended multi-day runs on a machine you care about, use a dedicated user or VM, or wait for `sandbox = "docker"` (M3): the agent's commands in a container with only the worktree mounted, CPU/memory limits and an optional egress allowlist.

## Worker backends

When worker adapters arrive (M3), the worker tool's own auto-approve means Omnexx's command policy doesn't apply inside it. Containment is the isolated worktree, a scrubbed env, push disabled through per-process git config, a ref-tamper check and the same gates. See [workers.md](workers.md).
