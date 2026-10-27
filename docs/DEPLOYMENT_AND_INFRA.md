# Omnexx Deployment & Infrastructure Architecture

> **Essential Ground Rule**: The central source of truth for deployment orchestration is the monorepo [`yaegerbomb42/infra`](https://github.com/yaegerbomb42/infra).

## 1. High-Level Architecture (The Rule)

Omnexx strictly follows the Hub & VPS infrastructure model:

| Component | Host / Environment | Route / Address | Method |
|---|---|---|---|
| **Frontend Landing Site** | **GitHub Pages** (The Hub) | `https://yaegerbomb42.github.io/omnexx/`<br>`https://omnexx.org` | Built statically, hosted on GitHub Pages |
| **Backend Daemon / Runners** | **Oracle Cloud VPS** (`147.224.158.118`) | Nginx reverse proxy `:8116`<br>systemd user unit | Long-running agent runners & coordination |

### Frontend (Static on GitHub Pages)
* The user-facing landing site and installation documentation are hosted statically on **GitHub Pages** via the `.hub` worktree in the `infra` repo.
* **Custom Domain**: `https://omnexx.org` points to the VPS reverse proxy on Port 8116, which serves the identical static build with strict security headers (or rewrites to GitHub Pages).
* **Deploy Command**: 
  ```bash
  # Run from yaegerbomb42/infra
  ./deploy.sh omnexx --pages
  ```
* **Never**: Do not attempt to run dynamic server-side node processes for the landing page or build server-rendered frontends on the VPS for `omnexx.org`.

### Backend & Service (Oracle Cloud VPS)
* Long-running, autonomous unsteered sessions, worker supervisors, and persistent agent runs execute on the always-on **Oracle Cloud VPS** (`147.224.158.118`).
* Managed via `systemd` user units:
  ```bash
  # Check status on the VPS
  omnexx status
  omnexx ps
  
  # VPS user service configuration
  omnexx service install
  ```
* The VPS engine and dockerized services are version-controlled under `.infra/vps/` in the `yaegerbomb42/infra` repo.

## 2. Deploying Changes

All deployments are driven by the unified deploy script in `infra`:

```bash
# Check configuration and syntax
./deploy.sh check

# Publish frontend updates to GitHub Pages
./deploy.sh omnexx --pages

# Sync backend / VPS configurations
./deploy.sh omnexx --vps
```

## 3. Summary Directives for AI Agents & Contributors
1. **Frontends live on GitHub Pages**: All landing updates must compile to static assets published to `yaegerbomb42.github.io/omnexx/`.
2. **Backends live on the VPS**: Compute, memory, background processes, and persistent agent runs stay on `147.224.158.118`.
3. **Keep `main` clean**: `main` is the only long-lived branch across both `omnexx` and `infra`.
