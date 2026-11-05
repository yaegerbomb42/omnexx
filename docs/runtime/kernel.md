# Adaptive Runtime Kernel

Real-Time Agent OS control plane under `src/runtime/kernel/`. **On by default**; set `enabled = false` to opt out.

## Hybrid control plane

1. **Deterministic telemetry** (`TelemetryMonitor`) — friction \(F_t\), context pressure \(P_t\) (default ceiling 0.65 of model window), epistemic uncertainty from logprobs **and** multi-sample allocation divergence.
2. **Local Ollama meta-router** (`LocalMetaRouter` + `CapabilityIndex`) — `keep_alive: -1`, `temperature: 0`, JSON-schema `TurnAllocation`. Probes Ollama once (~80ms); if absent, stays on TF-IDF + heuristics with no further network.
3. **MCTS rollouts** (`runMcts`) — on tier 2 / `reasoningMode: mcts`, expands `mctsBranchFactor` allocation branches, scores them with a verifier over telemetry + capability coverage (UCB1), selects the best. No frontier-model calls.
4. **Tier-3 context GC** (`ContextGarbageCollector`) — embedding/fingerprint compaction of near-duplicate tool results beyond the existing fold/clear path; applied when pressure is high.
5. **DAG checkpointer** (`StateCheckpointer` + `MemoryVfs`) — snapshots before mutating tools via git dirty files, with a full in-memory VFS fallback for non-git workspaces.

## Config

```toml
[kernel]
enabled = true          # default; set false to disable
ollama_url = "http://127.0.0.1:11434"
ollama_model = "qwen2.5:3b"
embed_model = "nomic-embed-text"
attention_ceiling = 0.65
max_mounted = 8
reselect_every = 4
registry = true
local_discovery = true
public_skills = true
```

Env: `OMNEXX_KERNEL_ENABLED`, `OMNEXX_KERNEL_OLLAMA_URL`, `OMNEXX_KERNEL_OLLAMA_MODEL`  
VS Code: `omnexx.kernel.enabled` (default true), `omnexx.kernel.ollamaUrl`, `omnexx.kernel.ollamaModel`

## Capability catalog (dynamic MCP / skills)

The kernel indexes thousands of capabilities and mounts only a small working set into the model context:

1. **Official MCP Registry** (`registry.modelcontextprotocol.io/v0/servers`) — paginated live fetch on warm, cached under `~/.config/omnexx/cache/`, with offline fallback to the bundled gzip snapshot at `src/runtime/kernel/data/mcp-registry-snapshot.json.gz` (real registry data, committed).
2. **Local MCP configs** — Omnexx `[mcp].servers`, project `.mcp.json`, Claude Desktop, Cursor, and VS Code `mcp.json` when present. Tool schemas are fetched lazily on mount, not at index time.
3. **Real skills** — Omnexx skill dirs plus `SKILL.md` trees under `~/.claude/skills`, `~/.cursor/skills`, and project `.cursor/skills`. Optional enrichment via the real [SkillMD](https://skillmd.com/) public search API (`api.skillmd.com`); Omnexx never invents a fake skills index.
4. **Meta-tools** — `search_capabilities` / `mount_capability`. Selecting a not-yet-installed `registry:*` id returns an **install suggestion** only; Omnexx will not auto-install or run untrusted code.
5. **Live injection** — mounting an installed `local:mcp:*` server lazy-connects it, lists tools, and injects `mcp__server__tool` entries into the model-visible tool list for subsequent turns; unmount removes them. Mounted skills are paged into the `[kernel:skills]` system hint.
6. **Synthetic 2k bench** — `syntheticCatalog(2000)` remains for perf tests; production warm uses real sources.

```toml
[kernel]
max_mounted = 8
reselect_every = 4
registry = true
local_discovery = true
public_skills = true
```


## Degradation

With no Ollama installed the kernel still runs: one failed probe marks the instance offline, warm/index use TF-IDF only, allocate uses heuristics, MCTS/GC/checkpoints are pure local CPU. A normal turn's kernel overhead stays well under ~5ms after the first probe.
