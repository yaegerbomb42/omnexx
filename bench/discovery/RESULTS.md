# Capability discovery + prompt-cache results (2026-11-05)

Catalog: full official MCP registry snapshot (56,396 servers) + local tools/skills.
`npm run eval:discovery -- --ranker <r> [--heldout] [--select]`, `npm run bench:cache`.

## Ranking — main (55 tasks) / held-out (25 tasks, written after tuning)

| ranker                                     | recall@5     | recall@10  | MRR           | P@5           | installed@1 | p50     |
| ------------------------------------------ | ------------ | ---------- | ------------- | ------------- | ----------- | ------- |
| baseline (TF-IDF, 7.4k truncated snapshot) | 0.526 / 0.36 | 0.561 / –  | 0.399 / 0.27  | 0.178 / –     | 0.182 / –   | 7.7ms   |
| BM25 + expansion + priors                  | 0.965 / 0.80 | 1.0 / –    | 0.765 / 0.673 | 0.651 / –     | 0.727 / 1.0 | 5ms     |
| hybrid BM25 + nomic-embed (w=0.5, default) | 0.947 / 0.84 | 1.0 / 0.88 | 0.791 / 0.716 | 0.647 / 0.52  | 0.818 / 1.0 | ~100ms* |
| hybrid (w=0.3)                             | 0.965 / 0.84 | 1.0 / 0.88 | 0.787 / 0.68  | 0.644 / 0.488 | 0.818 / 1.0 | ~100ms* |

\* query embedding through local Ollama on CPU; BM25 alone stays ~5ms.

## Mount-set selection (maxMounted 6), top-k -> chooseMountSet — main / held-out

coverage 0.965→0.982 / 0.84→0.88 · slot efficiency 0.167→0.221 / 0.14→0.20 ·
avg mounted 6→4.6 / 6→4.4 · churn/turn 2.05→1.08 / 2.35→1.31

## Prompt cache (40-turn simulated kernel chat; read 0.1x, write 1.25x)

| policy                                  | billed tok-eq | x uncached | cache hit |
| --------------------------------------- | ------------- | ---------- | --------- |
| naive (before)                          | 192,811       | 0.532      | 62.5%     |
| frozen tools                            | 170,242       | 0.456      | 68.8%     |
| frozen tools + hints in directive       | 99,835        | 0.267      | 85.2%     |
| full (+ cache-gated GC / epoch re-bake) | 97,982        | 0.255      | 86.3%     |
