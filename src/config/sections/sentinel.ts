import { z } from 'zod';

/**
 * [sentinel]: catch regressions that slipped past per-cycle gates on long runs.
 *
 * Each cycle only proves its own gates (often related tests). Over a 24h run, small latent breaks
 * pile up. Every `every_commits` accepted commits the sentinel runs a full check (`command`) on
 * lastGreen. If it fails, it bisects the run's own checkpoint commits to find the first bad one
 * and reverts it with a new commit (history is never rewritten). Off by default.
 */
export const sentinel = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** Full-suite command, run through the shell in the worktree. Exit 0 means healthy. */
    command: z.string().min(1).default('npm test'),
    /** Run the sentinel after this many accepted commits. */
    every_commits: z.number().int().min(1).max(500).default(10),
    /** Per-invocation timeout for `command`, in seconds. */
    timeout_seconds: z.number().int().min(10).max(7_200).default(900),
    /** Revert the culprit automatically. When false, only report it. */
    auto_revert: z.boolean().default(true),
  })
  .prefault({});
