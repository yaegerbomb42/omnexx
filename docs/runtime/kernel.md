# Adaptive Runtime Kernel

Opt-in Real-Time Agent OS control plane under `src/runtime/kernel/`.

## Hybrid control plane

1. **Deterministic telemetry** (`TelemetryMonitor`) tracks friction \(F_t\), context pressure \(P_t\), and epistemic uncertainty. Instant threshold checks; no LLM.
2. **Local Ollama meta-router** (`LocalMetaRouter` + `CapabilityIndex`) for zero-cost turn allocation: reasoning mode, roles, JIT tool/skill mounting, token budgets. Falls back to BM25/TF-IDF + heuristics when Ollama is unreachable.

## Enable

```toml
[kernel]
enabled = true
ollama_url = "http://127.0.0.1:11434"
ollama_model = "qwen2.5:3b"
embed_model = "nomic-embed-text"
attention_ceiling = 0.65
```

Env: `OMNEXX_KERNEL_ENABLED`, `OMNEXX_KERNEL_OLLAMA_URL`, `OMNEXX_KERNEL_OLLAMA_MODEL`.

VS Code: `omnexx.kernel.enabled`, `omnexx.kernel.ollamaUrl`, `omnexx.kernel.ollamaModel`.

When `enabled = false` (default), the agent loop is unchanged.

## Deferred

- Full MCTS parallel rollouts (allocation sets `mctsBranchFactor`; loop does not spawn branches yet)
- Tier-3 async context GC beyond existing compaction triggers
- Non-git VFS checkpointing beyond in-memory dirty-file snapshots
- Epistemic uncertainty from multi-sample divergence (logprob path is implemented)
