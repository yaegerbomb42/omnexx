import { z } from 'zod';
import { ok, type Tool, type ToolContext } from './types.js';
import { TOOL_GROUPS, toolsInGroup, groupOf, ALWAYS_LOADED_TOOLS } from './groups.js';
import { exposedTools, toolSpec, type ExposureOptions } from './registry.js';
import { workerTools } from './registry.js';
import type { OmnexxConfig } from '../config/schema.js';

/**
 * State for tracking loaded tool groups in a session.
 * This is stored on the Run/loop state and survives context compaction.
 */
export interface LoadedToolsState {
  /** Set of loaded group names */
  loadedGroups: Set<string>;
  /** Map of tool name -> its group (for auto-loading) */
  toolToGroup: Map<string, string>;
  /** LRU order of loaded groups (most recent last) */
  lruOrder: string[];
  /** Maximum groups to keep loaded (optional cap) */
  maxLoadedGroups?: number;
}

/**
 * Initialize the loaded tools state with always-loaded groups.
 */
export function initLoadedToolsState(config: OmnexxConfig): LoadedToolsState {
  const toolToGroup = new Map<string, string>();
  // Build reverse mapping from all tool groups
  for (const [group, tools] of Object.entries(TOOL_GROUPS)) {
    for (const tool of tools) {
      toolToGroup.set(tool, group);
    }
  }

  // Always-loaded groups (core tools)
  const loadedGroups = new Set<string>(['fs', 'shell']); // Core file/shell tools always loaded
  // Also ensure always-loaded individual tools are covered
  for (const tool of ALWAYS_LOADED_TOOLS) {
    const group = toolToGroup.get(tool);
    if (group) loadedGroups.add(group);
  }

  return {
    loadedGroups,
    toolToGroup,
    lruOrder: [...loadedGroups],
    maxLoadedGroups: config.tools?.max_loaded_groups,
  };
}

/**
 * Check if a tool's group is loaded.
 */
export function isToolLoaded(state: LoadedToolsState, toolName: string): boolean {
  if (ALWAYS_LOADED_TOOLS.has(toolName)) return true;
  const group = state.toolToGroup.get(toolName);
  return group !== undefined && state.loadedGroups.has(group);
}

/**
 * Load a tool group (and its tools) into the session.
 */
export function loadToolGroup(state: LoadedToolsState, group: string): { loaded: string[]; unknown: string[] } {
  const tools = toolsInGroup(group);
  const unknown = tools.filter((t) => !state.toolToGroup.has(t)); // Shouldn't happen with built-in groups
  if (!state.loadedGroups.has(group)) {
    state.loadedGroups.add(group);
    state.lruOrder.push(group);
    // Enforce LRU cap if set
    if (state.maxLoadedGroups && state.lruOrder.length > state.maxLoadedGroups) {
      const toRemove = state.lruOrder.shift();
      if (toRemove && !['fs', 'shell'].includes(toRemove)) { // Never unload core groups
        state.loadedGroups.delete(toRemove);
      }
    }
  }
  return { loaded: tools, unknown };
}

/**
 * Load multiple tool groups.
 */
export function loadToolGroups(state: LoadedToolsState, groups: string[]): { loaded: string[]; unknown: string[] } {
  const allLoaded: string[] = [];
  const allUnknown: string[] = [];
  for (const group of groups) {
    const { loaded, unknown } = loadToolGroup(state, group);
    allLoaded.push(...loaded);
    allUnknown.push(...unknown);
  }
  return { loaded: allLoaded, unknown: allUnknown };
}

/**
 * Load tools by name (loads their groups).
 */
export function loadToolsByName(state: LoadedToolsState, toolNames: string[]): { loaded: string[]; unknown: string[] } {
  const groups = new Set<string>();
  const unknown: string[] = [];
  for (const tool of toolNames) {
    if (ALWAYS_LOADED_TOOLS.has(tool)) continue;
    const group = state.toolToGroup.get(tool);
    if (group) {
      groups.add(group);
    } else {
      unknown.push(tool);
    }
  }
  const { loaded } = loadToolGroups(state, [...groups]);
  return { loaded, unknown };
}

/**
 * Build the tool list for a provider request in lazy mode.
 * Only includes tools from loaded groups + always-loaded tools.
 */
export async function buildLazyToolList(
  config: OmnexxConfig,
  where: { repoRoot: string; env: NodeJS.ProcessEnv } | undefined,
  state: LoadedToolsState,
  exposureOpts: ExposureOptions,
): Promise<readonly Tool[]> {
  const allTools = await workerTools(config, where);

  // Filter to only loaded groups + always-loaded
  const filtered = allTools.filter((tool) => {
    if (ALWAYS_LOADED_TOOLS.has(tool.name)) return true;
    const group = state.toolToGroup.get(tool.name);
    return group !== undefined && state.loadedGroups.has(group);
  });

  return exposedTools(filtered, exposureOpts);
}

/**
 * Build the full tool list (for non-lazy mode).
 */
export async function buildFullToolList(
  config: OmnexxConfig,
  where: { repoRoot: string; env: NodeJS.ProcessEnv } | undefined,
  exposureOpts: ExposureOptions,
): Promise<readonly Tool[]> {
  const allTools = await workerTools(config, where);
  return exposedTools(allTools, exposureOpts);
}

/**
 * The request_tools meta-tool.
 * Input: { groups?: string[], tools?: string[] }
 * Loads the requested groups/tools and returns confirmation.
 */
export function createRequestToolsTool(state: LoadedToolsState): Tool {
  const schema = z.strictObject({
    groups: z.array(z.string()).optional().describe('Tool groups to load (e.g., "memory", "web", "browser")'),
    tools: z.array(z.string()).optional().describe('Specific tool names to load (loads their groups)'),
  });

  return {
    name: 'request_tools',
    description: 'Load full definitions for tool groups or specific tools. In lazy mode, only core tools are loaded by default. Call this to access specialized tools like memory, web, browser, etc.',
    schema,
    readOnly: true,
    async run({ groups, tools }, _ctx) {
      const loadedTools: string[] = [];
      const unknownGroups: string[] = [];
      const unknownTools: string[] = [];

      if (groups && groups.length) {
        for (const group of groups) {
          if (!TOOL_GROUPS[group]) {
            unknownGroups.push(group);
            continue;
          }
          const { loaded, unknown } = loadToolGroup(state, group);
          loadedTools.push(...loaded);
          unknownTools.push(...unknown);
        }
      }

      if (tools && tools.length) {
        const { loaded, unknown } = loadToolsByName(state, tools);
        loadedTools.push(...loaded);
        unknownTools.push(...unknown);
      }

      const uniqueLoaded = [...new Set(loadedTools)];
      let message = `Loaded ${uniqueLoaded.length} tool(s): ${uniqueLoaded.join(', ') || 'none'}`;
      if (unknownGroups.length) message += `. Unknown groups: ${unknownGroups.join(', ')}`;
      if (unknownTools.length) message += `. Unknown tools: ${unknownTools.join(', ')}`;
      message += `. Currently loaded groups: ${[...state.loadedGroups].join(', ')}`;

      return ok(message);
    },
  };
}

/**
 * Auto-load a tool's group if not already loaded.
 * Returns the group name that was loaded, or undefined if already loaded.
 */
export function autoLoadToolGroup(state: LoadedToolsState, toolName: string): string | undefined {
  if (ALWAYS_LOADED_TOOLS.has(toolName)) return undefined;
  const group = state.toolToGroup.get(toolName);
  if (!group) return undefined;
  if (!state.loadedGroups.has(group)) {
    loadToolGroup(state, group);
    return group;
  }
  return undefined;
}