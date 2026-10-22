import { z } from 'zod';

/**
 * [swe-bench]: execution preset optimized for SWE-bench-style issue-fix tasks.
 *
 * When enabled, the agent uses hierarchical fault localization to narrow the search space,
 * requires a reproduction test before editing source, and enforces fail-to-pass plus
 * pass-to-pass gates. Beyond mode is disabled (fix the issue, nothing more).
 *
 * CLI: `omnexx run --preset swe-bench` or set `[swe-bench] enabled = true` in config.
 */
export const sweBench = z
  .strictObject({
    /** Activate the SWE-bench execution preset. */
    enabled: z.boolean().default(false),

    /**
     * Localization strategy:
     * - "hierarchical": file → element → line narrowing (recommended for large repos)
     * - "full": use the full codemap (smaller repos or when localization fails)
     */
    localization: z.enum(['hierarchical', 'full']).default('hierarchical'),

    /** Top N files to consider during file-level localization. */
    localize_top_files: z.number().int().min(1).max(20).default(8),

    /** Top N elements (classes/functions) to consider per file. */
    localize_top_elements: z.number().int().min(1).max(10).default(5),

    /** Maximum tokens for file skeletons shown during element localization. */
    skeleton_max_tokens: z.number().int().positive().default(12_000),

    /**
     * Require a reproduction test that fails on the original tree before editing.
     * The test becomes a gate: the patch is accepted only when it passes.
     */
    require_reproduction: z.boolean().default(true),

    /** Maximum attempts to generate a valid reproduction test. */
    reproduction_max_attempts: z.number().int().min(1).max(5).default(3),

    /** Models for reproduction test generation. */
    reproduction_models: z.enum(['cheap', 'worker', 'planner']).default('planner'),

    /**
     * Fail-to-pass gate: the reproduction test must go from failing (red) to passing (green).
     * If it passes on the original tree, it's not reproducing the bug.
     */
    fail_to_pass_gate: z.boolean().default(true),

    /**
     * Pass-to-pass gate: existing regression tests must stay green.
     * This prevents fixes that break other functionality.
     */
    pass_to_pass_gate: z.boolean().default(true),

    /** Lines of context in the extracted patch diff (for SWE-bench submission format). */
    patch_context_lines: z.number().int().min(0).max(10).default(3),

    /**
     * Maximum repair loop rounds before giving up. Each round:
     * 1. Edit based on localization
     * 2. Run reproduction + regression tests
     * 3. Fix forward on failure
     */
    max_repair_rounds: z.number().int().min(1).max(20).default(6),

    /**
     * Parse stack traces from the issue to seed localization.
     * Files mentioned in stack traces are weighted higher.
     */
    parse_stack_traces: z.boolean().default(true),

    /**
     * Disable beyond mode when this preset is active.
     * SWE-bench tasks have a clear scope: fix the issue, nothing more.
     */
    disable_beyond: z.boolean().default(true),

    /**
     * Generate multiple candidate patches and rank by test results (Agentless-style).
     * 0 means generate one patch at a time (iterative fix-forward).
     */
    candidate_patches: z.number().int().min(0).max(10).default(0),
  })
  .prefault({});

export type SweBenchConfig = z.infer<typeof sweBench>;
