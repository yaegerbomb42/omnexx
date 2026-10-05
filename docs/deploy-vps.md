# VPS quickstart (Ubuntu, systemd)

For long runs on an always-on Linux box shared with other services.

```bash
# 1. Node 22+, git, ripgrep
sudo apt-get install -y git ripgrep
node --version        # >= 22

# 2. Install Omnexx from a checkout (it isn't on npm yet)
git clone https://github.com/yaegerbomb42/omnexx ~/omnexx
cd ~/omnexx && npm ci && npm run build && npm link

# 3. Key (stored as ~/.config/omnexx/credentials/anthropic.key, mode 0600)
omnexx auth set anthropic
omnexx doctor

# 4. Optional: keep the box responsive for production sites
mkdir -p ~/.config/omnexx
cat >> ~/.config/omnexx/config.toml <<'TOML'
[service]
nice = 10
cpu_quota = "150%"
memory_max = "4G"
TOML

# 5. Install the user service (runs `omnexx resume --all` at boot)
omnexx service install --dry-run      # inspect the unit first
omnexx service install
```

If linger is off, `service install` prints the command to run once (user services otherwise stop at logout and don't start at boot):

```bash
sudo loginctl enable-linger $USER
```

Start a run in your repo and walk away:

```bash
cd ~/src/myrepo && omnexx init
omnexx run --detach --budget 50 --hours 24 --goal-file SPEC.md
omnexx status
omnexx logs -f
```

After a reboot, crash or OOM kill, the service resumes every interrupted run from its persisted phase. Runs that stopped for a reason that needs you (`needs-human`, `budget-stop`, `user-stop`) stay stopped until `omnexx resume <runId>`.

Useful:

```bash
systemctl --user status omnexx.service
journalctl --user -u omnexx.service -f
omnexx service status
omnexx service uninstall
```

The fast judge does not run on the VPS; point `judge.nimble.url` at your Mac over Tailscale ([judge.md](judge.md)). Notifications: add `[notify.ntfy]` with a hard-to-guess topic ([config.md](config.md)).
