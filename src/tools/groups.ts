import type { Tool } from './types.js';

/**
 * Tool group definitions. Each group maps to a set of tool names.
 * Groups are derived from existing tool metadata/categories.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  /** File system: read & edit files */
  fs: ['read', 'outline', 'read_symbol', 'search', 'str_replace', 'multi_edit', 'replace_lines', 'write_file'],
  /** Shell commands */
  shell: ['bash', 'read_log'],
  /** Git operations */
  git: [], // Git tools don't exist as individual tools; bash handles git
  /** Search tools */
  search: ['search'],
  /** Web tools */
  web: ['web_fetch', 'web_search'],
  /** Browser tools */
  browser: ['browser'],
  /** Memory/notes tools */
  memory: ['remember', 'recall', 'context', 'running_context', 'query_artifact', 'repl_projection'],
  /** Task/agent tools */
  task: ['task', 'todo'],
  /** Core tools that are always available (not lazy-loadable) */
  core: ['finish', 'reply', 'done'], // These don't exist yet but conceptually would be here
};

/**
 * Core tool names that must always be fully defined in lazy mode.
 * These are the essential tools the agent needs to function.
 */
export const ALWAYS_LOADED_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'write_file',
  'str_replace',
  'bash',
  'search',
  'todo',
  'more_tools', // The meta-tool for lazy loading
  'request_tools', // The new meta-tool
]);

/**
 * Get the group name for a tool, or undefined if it's not in any group.
 */
export function groupOf(toolName: string): string | undefined {
  for (const [group, tools] of Object.entries(TOOL_GROUPS)) {
    if (tools.includes(toolName)) return group;
  }
  return undefined;
}

/**
 * Get all tools belonging to a group.
 */
export function toolsInGroup(group: string): string[] {
  return TOOL_GROUPS[group] ?? [];
}

/**
 * Build a compact index line for a tool group.
 */
export function groupIndexLine(group: string, allTools: readonly Tool[]): string {
  const toolNames = toolsInGroup(group);
  const groupTools = allTools.filter((t) => toolNames.includes(t.name));
  if (!groupTools.length) return '';
  const descriptions = groupTools.map((t) => t.name).join(', ');
  const shortDesc = groupTools[0].description.split('.')[0] + '.';
  return `- ${group}: ${shortDesc} — ${descriptions}`;
}

/**
 * Build the compact tool index for lazy mode.
 */
export function buildToolIndex(allTools: readonly Tool[]): string {
  // Include core groups + one per MCP server (handled separately)
  const coreGroups = ['fs', 'shell', 'search', 'web', 'browser', 'memory', 'task'];
  const lines: string[] = [];
  for (const group of coreGroups) {
    const line = groupIndexLine(group, allTools);
    if (line) lines.push(line);
  }
  // Note: MCP servers are handled separately in the mount layer (src/mcp/mount.ts)
  return lines.join('\n');
}