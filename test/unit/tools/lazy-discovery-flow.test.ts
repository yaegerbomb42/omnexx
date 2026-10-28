import { describe, it, expect } from 'vitest';
import {
  buildToolListSync,
  workerTools,
  toolSpec,
  exposedTools,
  buildToolIndexForPrompt,
} from '../../../src/tools/registry.js';
import {
  initLoadedToolsState,
  createRequestToolsTool,
  autoLoadToolGroup,
} from '../../../src/tools/request-tools.js';
import { estimateTokens } from '../../../src/core/tokens.js';
import type { OmnexxConfig } from '../../../src/config/schema.js';

// Mock config for testing (copied from lazy-discovery.test.ts)
function createMockConfig(overrides: Record<string, unknown> = {}): OmnexxConfig {
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

const EXPOSURE_OPTS = {
  subagents: true,
  hasHistory: true,
  autoApprove: false,
  lazyTools: false,
} as const;

describe('Lazy Tool Discovery Flow', () => {
  describe('Flag Off Leaves Payload Unchanged', () => {
    it('full mode payload equals exposedTools output', async () => {
      const config = createMockConfig({ tools: { discovery: 'full' } });
      const allTools = await workerTools(config, { repoRoot: '/test', env: {} });

      const fullPayload = buildToolListSync(allTools, config, EXPOSURE_OPTS, null);
      const exposedPayload = exposedTools(allTools, EXPOSURE_OPTS);

      const fullSpecs = fullPayload.map(toolSpec);
      const exposedSpecs = exposedPayload.map(toolSpec);

      expect(JSON.stringify(fullSpecs)).toBe(JSON.stringify(exposedSpecs));
    });
  });

  describe('Tool Index Lists Every Group', () => {
    it('buildToolIndexForPrompt lists all groups, marks loaded state, no schemas', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);

      // fs and shell are loaded by default, memory is not
      expect(state.loadedGroups.has('fs')).toBe(true);
      expect(state.loadedGroups.has('shell')).toBe(true);
      expect(state.loadedGroups.has('memory')).toBe(false);

      const index = buildToolIndexForPrompt(state);

      // Should contain lines for each group
      expect(index).toContain('fs');
      expect(index).toContain('shell');
      expect(index).toContain('web');
      expect(index).toContain('memory');

      // Should mark fs as loaded
      const fsLine = index.split('\n').find((line) => line.includes('fs'));
      expect(fsLine).toContain('loaded');

      // Should mark memory as not loaded
      const memoryLine = index.split('\n').find((line) => line.includes('memory'));
      expect(memoryLine).not.toContain('loaded');

      // Should not contain JSON schema fields
      expect(index).not.toContain('"type"');
      expect(index).not.toContain('properties');
    });
  });

  describe('request_tools Makes Tools Available on Next Refresh', () => {
    it('initial build excludes remember; after request_tools run, build includes remember', async () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);

      // Verify initial state: memory group not loaded
      expect(state.loadedGroups.has('memory')).toBe(false);

      // Get all tools
      const allTools = await workerTools(config, { repoRoot: '/test', env: {} });

      // Initial build should NOT include remember (memory group not loaded)
      const initialTools = buildToolListSync(allTools, config, EXPOSURE_OPTS, state);
      const initialNames = initialTools.map((t) => t.name);
      expect(initialNames).not.toContain('remember');
      expect(initialNames).not.toContain('recall');

      // Create request_tools tool and run it to load 'memory' group
      const requestToolsTool = createRequestToolsTool(state);
      await requestToolsTool.run({ groups: ['memory'] }, {} as never);

      // Verify state was updated
      expect(state.loadedGroups.has('memory')).toBe(true);

      // Next buildToolListSync should include remember
      const refreshedTools = buildToolListSync(allTools, config, EXPOSURE_OPTS, state);
      const refreshedNames = refreshedTools.map((t) => t.name);
      expect(refreshedNames).toContain('remember');
      expect(refreshedNames).toContain('recall');
    });
  });

  describe('Auto-Load on Unknown Call', () => {
    it('autoLoadToolGroup returns group first time, undefined second time; tools then available', async () => {
      const config = createMockConfig({
        tools: { discovery: 'lazy' },
        web: { fetch_enabled: true },
      });
      const state = initLoadedToolsState(config);

      // Verify web group not loaded initially
      expect(state.loadedGroups.has('web')).toBe(false);

      const allTools = await workerTools(config, { repoRoot: '/test', env: {} });

      // First call to autoLoadToolGroup for web_fetch should return 'web'
      const firstLoad = autoLoadToolGroup(state, 'web_fetch');
      expect(firstLoad).toBe('web');
      expect(state.loadedGroups.has('web')).toBe(true);

      // Second call should return undefined (already loaded)
      const secondLoad = autoLoadToolGroup(state, 'web_fetch');
      expect(secondLoad).toBeUndefined();

      // After auto-load, buildToolListSync should include web_fetch
      const toolsAfterLoad = buildToolListSync(allTools, config, EXPOSURE_OPTS, state);
      const namesAfterLoad = toolsAfterLoad.map((t) => t.name);
      expect(namesAfterLoad).toContain('web_fetch');
    });
  });

  describe('Token Drop Measurement', () => {
    it('lazy mode uses fewer tokens than full mode', async () => {
      const configFull = createMockConfig({
        tools: { discovery: 'full' },
        web: { fetch_enabled: true },
      });
      const configLazy = createMockConfig({
        tools: { discovery: 'lazy' },
        web: { fetch_enabled: true },
      });
      const state = initLoadedToolsState(configLazy);

      const allTools = await workerTools(configFull, { repoRoot: '/test', env: {} });

      // Full mode: all tools
      const fullTools = exposedTools(allTools, EXPOSURE_OPTS);
      const fullSpecs = fullTools.map(toolSpec);
      const fullTokens = estimateTokens(JSON.stringify(fullSpecs));

      // Lazy mode: only loaded groups (fs, shell) + always-loaded
      const lazyTools = buildToolListSync(allTools, configLazy, EXPOSURE_OPTS, state);
      const lazySpecs = lazyTools.map(toolSpec);
      const lazyTokens = estimateTokens(JSON.stringify(lazySpecs));

      // Tool index tokens
      const toolIndex = buildToolIndexForPrompt(state);
      const indexTokens = estimateTokens(toolIndex);

      // Total lazy = lazy tools + index
      const totalLazy = lazyTokens + indexTokens;

      expect(totalLazy).toBeLessThan(fullTokens);

      const saved = fullTokens - totalLazy;
      const savedPct = Math.round((saved / fullTokens) * 100);

      console.log(
        `[lazy-tools] full=${fullTokens} lazy=${totalLazy} saved=${saved} (${savedPct}%)`,
      );
    });
  });
});
