# SWE-bench 10x Architecture Audit

This document summarizes the findings from researching state-of-the-art SWE-bench approaches and
the design decisions for Omnexx's `swe-bench` execution preset.

## 1. State-of-the-Art Approaches

### 1.1 Hierarchical Fault Localization (Agentless, RGFL)

State-of-the-art systems use **hierarchical localization** to narrow down the search space:

1. **File-level**: Repository tree + LLM ranking + embedding retrieval → top N files
2. **Element-level**: Extract "skeleton" (class/function declarations) → LLM selects relevant elements
3. **Line-level**: Show full element code → LLM identifies exact edit locations

**Key findings (RGFL 2026):**

- File-level Hit@1: 71.4% → 85% with reasoning-guided approach
- Element-level Exact Match@3: 36% → 69%
- End-to-end repair improvement: +12.8% on SWE-bench Verified

**Implementation principle**: Never show the full repo to the model. Build compressed views
(skeletons, declarations) and expand only the localized regions.

### 1.2 Dynamic Symbol Indexing Without Context Blowup

Systems avoid context blowup through:

1. **Declaration skeletons**: Only show `class X:`, `def foo():` headers, not bodies
2. **Embedding retrieval**: Pre-compute embeddings for code chunks; retrieve by similarity
3. **Iterative expansion**: Start with file names → expand to skeletons → expand to code
4. **Repository tree**: Show structure (`src/auth/`, `tests/`) before content

**Omnexx advantage**: We already have `codemap.ts` that builds a lightweight symbol index with
`extractSymbols()`. Extend it to support:

- Skeleton generation (declarations without bodies)
- Purpose annotations from docstrings
- Incremental update on commit

### 1.3 Reproduction Test Synthesis

**RepoFixer approach (ICSE 2026):**

1. A "Searcher" agent performs fault localization
2. A "Fixer" agent first writes a reproduction script that fails on the original code
3. The reproduction script becomes the acceptance criterion for the patch
4. Iterate until the script passes (issue resolved)

**Key statistic**: 76.8% of generated reproduction scripts successfully differentiated
pre/post-patch behavior.

**Design decision**: Our `spec-tests.ts` already writes independent acceptance tests. Adapt it
to write a minimal reproduction test that:

- Fails on the current (buggy) tree
- Passes after the fix
- Uses only the issue description and public interface

### 1.4 Self-Healing Repair Loops

**Agentless approach:**

- Generate 40 candidate patches (4 location sets × 10 samples)
- Run reproduction test + regression tests
- Rank patches by test results; submit best

**SWE-agent / OpenHands approach:**

- ReAct loop with tool use
- Multi-turn conversation with test feedback
- Fix forward on failure (no full rollback)

**Omnexx advantage**: Our `think-loop.ts` already implements:

- Think-first exploration
- Fix-forward on check failure
- Doom-loop detection and rewind
- Review at the end

Extend for SWE-bench:

- Require reproduction test to pass (not just project tests)
- Fail-to-pass gate: the reproduction test must go from red to green
- Pass-to-pass gate: existing tests must stay green

---

## 2. Design Decisions for Omnexx SWE-bench Preset

### 2.1 Preset Philosophy

The `swe-bench` preset optimizes for **issue-fix tasks**: a natural-language bug report or
feature request, a codebase, and hidden tests. It differs from the default mode by:

1. **Requiring reproduction-test synthesis** before touching source
2. **Using hierarchical localization** instead of full codemap
3. **Enforcing fail-to-pass + pass-to-pass gates**
4. **Disabling "beyond" mode** (no hardening after the issue is fixed)

### 2.2 Module Structure

```
src/swe-bench/
├── index.ts              # Preset entry point and orchestration
├── localize.ts           # Hierarchical fault localization
├── skeleton.ts           # Code skeleton extraction (declarations only)
├── reproduce.ts          # Reproduction test synthesis
├── patch-diff.ts         # Patch diff extraction and formatting
└── repair-loop.ts        # Self-healing repair loop wrapper

src/config/sections/
└── swe-bench.ts          # Configuration schema for the preset
```

### 2.3 Localization Strategy

```typescript
interface LocalizationResult {
  files: string[]; // Top N suspect files
  elements: ElementLoc[]; // Classes/functions within those files
  lines: LineLoc[]; // Specific line ranges to edit
}

interface ElementLoc {
  file: string;
  name: string; // e.g., "class AuthService", "function validateToken"
  startLine: number;
  endLine: number;
}
```

**Algorithm:**

1. Build repo tree (already in `trackedFiles()`)
2. LLM ranks top 5 files by issue description
3. Embedding retrieval adds 3 more files (top 8 total)
4. For each file, extract skeleton via `extractSymbols()` + signature lines
5. LLM selects top 3 elements per file
6. Show full element code; LLM marks exact edit lines

### 2.4 Reproduction Test Harness

The reproduction test:

1. Is written by a model that sees only the issue and public interface
2. Must fail on the original tree (if it passes, it's not reproducing the bug)
3. Becomes a gate: the patch is accepted only when it passes
4. Lives outside the repo (in run store) like spec tests

**Integration with existing `spec-tests.ts`:**

- Reuse `publicInterface()` for skeleton generation
- Reuse `parseSuite()` for test validation
- Add `fail-to-pass` check: run on original tree, must fail

### 2.5 Repair Loop Flow

```
1. Parse issue → extract key terms, error messages, stack traces
2. Hierarchical localization → file → element → line
3. Write reproduction test → verify it fails on original tree
4. Think-loop session:
   a. Think: analyze the localized code against the issue
   b. Execute: edit the localized regions
   c. Check: run reproduction test + project tests
   d. If red: fix forward with failure info
   e. If stuck: re-think with localization context
5. If reproduction test passes AND project tests pass:
   a. Extract patch diff
   b. Run one review pass
   c. Done
```

### 2.6 Patch Diff Extraction

For SWE-bench submission format:

- Unified diff (`git diff HEAD~1`) against the commit before edits
- Filter to only the files that were edited
- Strip context to ±3 lines (matches SWE-bench evaluation)

### 2.7 Configuration Schema

```toml
[swe-bench]
enabled = false                    # Activate the preset (CLI: --preset swe-bench)
localization = "hierarchical"      # "hierarchical" | "full" (full codemap)
localize_top_files = 8             # Files to consider
localize_top_elements = 5          # Elements per file
require_reproduction = true        # Must write and run a reproduction test
reproduction_max_attempts = 3      # Retries for reproduction test generation
fail_to_pass_gate = true           # Reproduction test must go red → green
pass_to_pass_gate = true           # Existing tests must stay green
patch_context_lines = 3            # Lines of context in extracted diff
```

---

## 3. Token Efficiency Analysis

### 3.1 Current Omnexx vs. Planned SWE-bench Mode

| Aspect                 | Default Mode       | SWE-bench Mode          |
| ---------------------- | ------------------ | ----------------------- |
| Initial context        | Full codemap       | Repo tree + issue       |
| Localization           | Model reads freely | Hierarchical, bounded   |
| Pre-edit gate          | None               | Reproduction test (red) |
| Post-edit gate         | Project tests      | Repro (green) + tests   |
| Beyond mode            | On (hardening)     | Off (issue-fix only)    |
| Estimated tokens/issue | 60-150k            | 30-80k                  |

### 3.2 Context Window Budget

For a 128k context model:

- System prompt + tools: ~4k
- Issue + repo tree: ~2k
- Top 8 file skeletons: ~8k (1k each)
- Expanded element code: ~12k (3 elements × 4k)
- Reproduction test: ~1k
- Conversation history: ~30k
- Reserve for output: ~16k
- **Buffer: ~55k**

This leaves headroom for retries and fix-forward without compaction.

---

## 4. Integration with Existing Omnexx Components

### 4.1 Reused Components

| Component         | Use in SWE-bench Mode                           |
| ----------------- | ----------------------------------------------- |
| `codemap.ts`      | Symbol extraction, file tracking                |
| `spec-tests.ts`   | Reproduction test template, `publicInterface()` |
| `think-loop.ts`   | Repair loop with fix-forward and doom-loop      |
| `review.ts`       | Final review before submission                  |
| `gates.ts`        | Running reproduction and regression tests       |
| `doom-breaker.ts` | Detecting oscillation in repair attempts        |

### 4.2 New Components

| Component                      | Purpose                                 |
| ------------------------------ | --------------------------------------- |
| `swe-bench/localize.ts`        | Hierarchical localization pipeline      |
| `swe-bench/skeleton.ts`        | Extract declaration skeletons from code |
| `swe-bench/reproduce.ts`       | Write and validate reproduction tests   |
| `swe-bench/patch-diff.ts`      | Extract submission-ready patch diffs    |
| `config/sections/swe-bench.ts` | Preset configuration                    |

---

## 5. Future Extensions

### 5.1 Multi-file Edit Coordination

For issues spanning multiple files, coordinate edits:

1. Localize all affected files together
2. Plan edit order by dependency (callees before callers)
3. Run reproduction test after each file, not after each edit

### 5.2 Stack Trace Parsing

When the issue includes a stack trace:

1. Parse frame locations (file:line)
2. Seed localization with those files
3. Weight them higher in ranking

### 5.3 Similar Issue Retrieval

For repositories with issue history:

1. Embed the issue
2. Find similar past issues with their fixes
3. Include the fix patterns in the think prompt

---

## 6. Acceptance Criteria for This PR

- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run test:quick` passes
- [ ] Config section `[swe-bench]` parses correctly
- [ ] Localization produces valid file/element/line results
- [ ] Reproduction test harness writes a failing test
- [ ] Patch diff extractor produces valid unified diffs
- [ ] Integration test: mock issue → localize → reproduce → fix → pass
