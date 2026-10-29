import type { OmnexxConfig } from '../../../src/config/schema.js';
import type { ToolContext } from '../../../src/tools/types.js';

/**
 * Shared test configuration and constants for lazy tool discovery tests.
 */

/** Default exposure options used across lazy tool discovery tests. */
export const EXPOSURE_OPTS = {
  subagents: true,
  hasHistory: true,
  autoApprove: false,
  lazyTools: false,
} as const;

/**
 * Creates a mock OmnexxConfig for testing with optional overrides.
 * Uses `as unknown as OmnexxConfig` to satisfy the strict config type.
 */
export function createMockConfig(overrides: Record<string, unknown> = {}): OmnexxConfig {
  return {
    experimental: false,
    budget: { max_usd: 100, max_hours: 1 },
    providers: { anthropic: { api_key: 'test', max_tokens: 4096 } },
    context: { subagents: false, lazy_tools: false, sections: {}, progress_tail: 10 },
    policy: { auto_approve: false },
    execution: { mode: 'auto', domain: 'swe' },
    models: {
      planner: 'anthropic:claude-sonnet',
      worker: 'anthropic:claude-sonnet',
      cheap: 'anthropic:claude-haiku',
    },
    git: { push: 'none' },
    sandbox: 'host',
    tools: { discovery: 'full' },
    search: { embeddings: false },
    agents: { dirs: [], import_claude: false, remote: {} },
    browser: { enabled: false },
    skills: { dirs: [], import_claude: false },
    web: { fetch_enabled: false },
    ...overrides,
  } as unknown as OmnexxConfig;
}

/**
 * Type for the ToolContext used in tests (partial, since most fields aren't needed).
 */
export type MockToolContext = ToolContext & Record<string, never>;

/** Creates a minimal mock ToolContext for tool.run() calls. */
export function createMockToolContext(): MockToolContext {
  return {} as MockToolContext;
}
