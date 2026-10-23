/**
 * Work domains: what kind of work a run does. A separate axis from the execution posture
 * ([execution] mode: efficient / normal / extreme, how hard the agent tries).
 *
 * - "swe" (default): software engineering, exactly today's behavior — AST/symbol tools,
 *   compiler and test gates, spec acceptance tests, git rollback on regressions.
 * - "general": general-purpose autonomous work — documents, data files, research and other
 *   artifacts. Code-only tools stay out of the toolset, verification leans on task checks
 *   (shell assertions, validators, artifact checks) instead of a test suite, and the spec
 *   test gate is skipped: no suite is expected to exist.
 *
 * Set it with `--mode <swe|general>`, the OMNEXX_EXECUTION_DOMAIN env var, or
 * `[execution] domain` in omnexx.toml; the usual layer precedence applies
 * (flags > env > project file > user file).
 */
export type WorkMode = 'swe' | 'general';

export const WORK_MODES = ['swe', 'general'] as const;

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === 'string' && (WORK_MODES as readonly string[]).includes(value);
}

/** The work domain a loaded config selects; "swe" unless the config says otherwise. */
export function workModeOf(config: { execution: { domain?: unknown } }): WorkMode {
  return isWorkMode(config.execution.domain) ? config.execution.domain : 'swe';
}
