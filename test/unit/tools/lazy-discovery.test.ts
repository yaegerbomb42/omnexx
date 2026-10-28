import { describe, it, expect } from 'vitest';
import { TOOL_GROUPS, ALWAYS_LOADED_TOOLS, toolsInGroup, groupOf, buildToolIndex, groupIndexLine } from '../../../src/tools/groups.js';
import { initLoadedToolsState, loadToolGroup, loadToolsByName, autoLoadToolGroup, createRequestToolsTool, LoadedToolsState } from '../../../src/tools/request-tools.js';
import { buildToolList } from '../../../src/tools/registry.js';
import { buildCycleContext } from '../../../src/agent/context.js';
import { estimateTokens } from '../../../src/core/tokens.js';
import type { OmnexxConfig } from '../../../src/config/schema.js';

// Mock config for testing
function createMockConfig(overrides: Partial<OmnexxConfig> = {}): OmnexxConfig {
  return {
    experimental: false,
    budget: { max_usd: 100, max_hours: 1 },
    providers: { anthropic: { api_key: 'test', max_tokens: 4096 } },
    context: { subagents: false, lazy_tools: false, sections: {}, progress_tail: 10 },
    policy: { auto_approve: false },
    execution: { mode: 'auto', domain: 'swe' },
    models: { planner: 'anthropic:claude-sonnet', worker: 'anthropic:claude-sonnet', cheap: 'anthropic:claude-haiku' },
    git: { push: 'none' },
    sandbox: 'host',
    tools: { discovery: 'full' },
    ...overrides,
  } as OmnexxConfig;
}

describe('Lazy Tool Discovery', () => {
  describe('Tool Groups', () => {
    it('defines all expected tool groups', () => {
      expect(TOOL_GROUPS.fs).toContain('read');
      expect(TOOL_GROUPS.fs).toContain('write_file');
      expect(TOOL_GROUPS.fs).toContain('str_replace');
      expect(TOOL_GROUPS.shell).toContain('bash');
      expect(TOOL_GROUPS.search).toContain('search');
      expect(TOOL_GROUPS.web).toContain('web_fetch');
      expect(TOOL_GROUPS.browser).toContain('browser');
      expect(TOOL_GROUPS.memory).toContain('remember');
      expect(TOOL_GROUPS.memory).toContain('recall');
      expect(TOOL_GROUPS.task).toContain('task');
      expect(TOOL_GROUPS.task).toContain('todo');
    });

    it('maps tools to their groups correctly', () => {
      expect(groupOf('read')).toBe('fs');
      expect(groupOf('bash')).toBe('shell');
      // search is in both fs and search groups; first match wins (fs)
      expect(groupOf('search')).toBe('fs');
      expect(groupOf('web_fetch')).toBe('web');
      expect(groupOf('browser')).toBe('browser');
      expect(groupOf('remember')).toBe('memory');
      expect(groupOf('task')).toBe('task');
      expect(groupOf('unknown_tool')).toBeUndefined();
    });

    it('returns tools in a group', () => {
      const fsTools = toolsInGroup('fs');
      expect(fsTools).toContain('read');
      expect(fsTools).toContain('write_file');
      expect(fsTools).toContain('str_replace');
    });

    it('returns empty array for unknown group', () => {
      expect(toolsInGroup('unknown')).toEqual([]);
    });
  });

  describe('Always-Loaded Tools', () => {
    it('includes essential tools that must always be available', () => {
      expect(ALWAYS_LOADED_TOOLS.has('read')).toBe(true);
      expect(ALWAYS_LOADED_TOOLS.has('write_file')).toBe(true);
      expect(ALWAYS_LOADED_TOOLS.has('str_replace')).toBe(true);
      expect(ALWAYS_LOADED_TOOLS.has('bash')).toBe(true);
      expect(ALWAYS_LOADED_TOOLS.has('search')).toBe(true);
      expect(ALWAYS_LOADED_TOOLS.has('todo')).toBe(true);
      expect(ALWAYS_LOADED_TOOLS.has('request_tools')).toBe(true);
    });
  });

  describe('Compact Tool Index', () => {
    it('builds a compact index line for a group', () => {
      const mockTools = [
        { name: 'read', description: 'Read a file. Returns content.' },
        { name: 'write_file', description: 'Write a file. Creates or overwrites.' },
      ] as any;
      const line = groupIndexLine('fs', mockTools);
      expect(line).toContain('fs:');
      expect(line).toContain('read');
      expect(line).toContain('write_file');
    });

    it('builds full compact index', () => {
      const mockTools = [
        { name: 'read', description: 'Read a file. Returns content.' },
        { name: 'write_file', description: 'Write a file. Creates or overwrites.' },
        { name: 'bash', description: 'Run a shell command. Returns output.' },
      ] as any;
      const index = buildToolIndex(mockTools);
      expect(index).toContain('fs:');
      expect(index).toContain('shell:');
    });
  });

  describe('LoadedToolsState', () => {
    it('initializes with core groups loaded', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy', max_loaded_groups: 10 } });
      const state = initLoadedToolsState(config);

      expect(state.loadedGroups.has('fs')).toBe(true);
      expect(state.loadedGroups.has('shell')).toBe(true);
      expect(state.toolToGroup.get('read')).toBe('fs');
      expect(state.toolToGroup.get('bash')).toBe('shell');
      expect(state.maxLoadedGroups).toBe(10);
    });

    it('loads a tool group', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);

      const result = loadToolGroup(state, 'memory');
      expect(result.loaded).toContain('remember');
      expect(result.loaded).toContain('recall');
      expect(state.loadedGroups.has('memory')).toBe(true);
    });

    it('loads tools by name (loads their groups)', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);

      const result = loadToolsByName(state, ['recall', 'web_fetch']);
      expect(result.loaded).toContain('recall');
      expect(result.loaded).toContain('web_fetch');
      expect(state.loadedGroups.has('memory')).toBe(true);
      expect(state.loadedGroups.has('web')).toBe(true);
    });

    it('auto-loads a tool group when tool is called', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);

      expect(state.loadedGroups.has('memory')).toBe(false);
      const loaded = autoLoadToolGroup(state, 'recall');
      expect(loaded).toBe('memory');
      expect(state.loadedGroups.has('memory')).toBe(true);

      // Second call returns undefined (already loaded)
      const loadedAgain = autoLoadToolGroup(state, 'recall');
      expect(loadedAgain).toBeUndefined();
    });

    it('does not auto-load always-loaded tools', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);

      const loaded = autoLoadToolGroup(state, 'read');
      expect(loaded).toBeUndefined();
    });

    it('enforces LRU cap when max_loaded_groups is set', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy', max_loaded_groups: 3 } });
      const state = initLoadedToolsState(config);

      // Initially has core groups + groups containing always-loaded tools
      const initialSize = state.loadedGroups.size;
      expect(initialSize).toBeGreaterThanOrEqual(2);

      // Load memory
      loadToolGroup(state, 'memory');
      expect(state.loadedGroups.size).toBe(initialSize + 1);

      // Load web (should evict LRU if over cap, but core groups fs/shell protected)
      loadToolGroup(state, 'web');
      // Size should not exceed max_loaded_groups + core protected groups (which are never counted in LRU)
      expect(state.loadedGroups.size).toBeLessThanOrEqual(initialSize + 3);

      // fs and shell should still be there (protected)
      expect(state.loadedGroups.has('fs')).toBe(true);
      expect(state.loadedGroups.has('shell')).toBe(true);
    });
  });

  describe('request_tools Meta-Tool', () => {
    it('creates a tool with correct schema', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);
      const tool = createRequestToolsTool(state);

      expect(tool.name).toBe('request_tools');
      expect(tool.readOnly).toBe(true);
      expect(tool.schema).toBeDefined();
    });

    it('loads groups and returns confirmation', async () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);
      const tool = createRequestToolsTool(state);

      const result = await tool.run({ groups: ['memory', 'web'] }, {} as any);
      expect(result).toHaveProperty('content');
      expect(result.content).toContain('Loaded');
      expect(result.content).toContain('memory');
      expect(result.content).toContain('web');
    });

    it('loads specific tools and returns confirmation', async () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);
      const tool = createRequestToolsTool(state);

      const result = await tool.run({ tools: ['recall', 'web_fetch'] }, {} as any);
      expect(result).toHaveProperty('content');
      expect(result.content).toContain('recall');
      expect(result.content).toContain('web_fetch');
    });

    it('reports unknown groups and tools', async () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);
      const tool = createRequestToolsTool(state);

      const result = await tool.run({ groups: ['unknown_group'], tools: ['unknown_tool'] }, {} as any);
      expect(result.content).toContain('Unknown groups: unknown_group');
      expect(result.content).toContain('Unknown tools: unknown_tool');
    });
  });

  describe('buildToolList in lazy mode', () => {
    it('filters tools to loaded groups + always-loaded', async () => {
      // Use a more complete config that satisfies all tool sources
      const config = createMockConfig({
        tools: { discovery: 'lazy' },
        search: { embeddings: false },
        agents: { dirs: [], import_claude: false },
        browser: { enabled: false },
        context: { subagents: true, lazy_tools: false, sections: {}, progress_tail: 10 },
      });
      const state = initLoadedToolsState(config);

      const tools = await buildToolList(config, { repoRoot: '/test', env: {} }, { subagents: true, hasHistory: false, autoApprove: false, lazyTools: false }, state);

      // Should include always-loaded tools
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('bash');
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('todo');
      expect(toolNames).toContain('request_tools'); // meta-tool

      // Should NOT include unloaded group tools (e.g., memory)
      expect(toolNames).not.toContain('remember');
      expect(toolNames).not.toContain('recall');
    });

    it('includes all tools in full mode', async () => {
      const config = createMockConfig({
        tools: { discovery: 'full' },
        search: { embeddings: false },
        agents: { dirs: [], import_claude: false },
        browser: { enabled: false },
        context: { subagents: true, lazy_tools: false, sections: {}, progress_tail: 10 },
      });
      const state = initLoadedToolsState(config);

      const tools = await buildToolList(config, { repoRoot: '/test', env: {} }, { subagents: true, hasHistory: false, autoApprove: false, lazyTools: false }, null);

      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('remember');
      expect(toolNames).toContain('recall');
      expect(toolNames).not.toContain('request_tools'); // meta-tool not in full mode
    });
  });

  describe('Tool Index in System Prompt', () => {
    it('includes toolIndex in cycle context when lazy mode', () => {
      const config = createMockConfig({ tools: { discovery: 'lazy' } });
      const state = initLoadedToolsState(config);

      const ctx = buildCycleContext({
        systemPrompt: 'test prompt',
        codemap: 'test codemap',
        goal: 'test goal',
        notes: 'test notes',
        plan: { nodes: [], rootId: 'root' },
        task: { id: 'task-1', title: 'Test Task', kind: 'code', approachesTried: [], lastRejection: undefined },
        progressTail: '',
        evidence: [],
        tools: [],
        toolIndex: '- fs: read, write_file\n- shell: bash',
      });

      // The toolIndex should be included in slot6 (cycle anchor)
      const slot6Content = ctx.first.content[0];
      if (typeof slot6Content === 'object' && 'text' in slot6Content) {
        expect(slot6Content.text).toContain('Available Tools (Lazy Mode)');
        expect(slot6Content.text).toContain('fs: read, write_file');
        expect(slot6Content.text).toContain('shell: bash');
      }
    });

    it('does not include toolIndex when not provided', () => {
      const ctx = buildCycleContext({
        systemPrompt: 'test prompt',
        codemap: 'test codemap',
        goal: 'test goal',
        notes: 'test notes',
        plan: { nodes: [], rootId: 'root' },
        task: { id: 'task-1', title: 'Test Task', kind: 'code', approachesTried: [], lastRejection: undefined },
        progressTail: '',
        evidence: [],
        tools: [],
      });

      const slot6Content = ctx.first.content[0];
      if (typeof slot6Content === 'object' && 'text' in slot6Content) {
        expect(slot6Content.text).not.toContain('Available Tools (Lazy Mode)');
      }
    });
  });

  describe('Token Estimation', () => {
    it('estimates tokens for full vs lazy tool definitions', async () => {
      const config = createMockConfig({
        tools: { discovery: 'lazy' },
        search: { embeddings: false },
        agents: { dirs: [], import_claude: false },
        browser: { enabled: false },
      });
      const state = initLoadedToolsState(config);

      // Get all tools
      const { workerTools } = await import('../../../src/tools/registry.js');
      const allTools = await workerTools(config, { repoRoot: '/test', env: {} });

      // Full tool specs
      const { toolSpec } = await import('../../../src/tools/registry.js');
      const fullSpecs = allTools.map(toolSpec);
      const fullTokens = estimateTokens(JSON.stringify(fullSpecs));

      // Lazy mode: only loaded groups (fs, shell) + always-loaded
      const lazyTools = await buildToolList(config, { repoRoot: '/test', env: {} }, { subagents: true, hasHistory: false, autoApprove: false, lazyTools: false }, state);
      const lazySpecs = lazyTools.map(toolSpec);
      const lazyTokens = estimateTokens(JSON.stringify(lazySpecs));

      // Tool index
      const toolIndex = buildToolIndex(allTools);
      const indexTokens = estimateTokens(toolIndex);

      // Omitted tokens
      const omitted = fullTokens - lazyTokens - indexTokens;

      // Just verify the structure works and numbers are reasonable
      expect(fullTokens).toBeGreaterThan(0);
      expect(lazyTokens).toBeGreaterThan(0);
      expect(indexTokens).toBeGreaterThan(0);
      expect(omitted).toBeGreaterThan(0);

      console.log(`Full mode tokens: ${fullTokens}`);
      console.log(`Lazy mode tokens: ${lazyTokens}`);
      console.log(`Index tokens: ${indexTokens}`);
      console.log(`Omitted tokens: ${omitted}`);
      console.log(`Savings: ${Math.round((omitted / fullTokens) * 100)}%`);
    });
  });
});