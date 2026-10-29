import { z } from 'zod';
import type { ToolSpec } from '../providers/types.js';
import { bashTool, readLogTool } from './bash.js';
import { multiEditTool, strReplaceTool, writeFileTool } from './edit.js';
import { outlineTool } from './outline.js';
import { readSymbolTool } from './read-symbol.js';
import { readTool } from './read.js';
import { replaceLinesTool } from './replace-lines.js';
import { contextTool } from './context.js';
import { recallTool } from './recall.js';
import { todoTool } from './todo.js';
import { DEFERRED_TOOLS, moreToolsTool } from './more-tools.js';
import { rememberTool } from './remember.js';
import { searchTool } from './search.js';
import { taskTool } from './task.js';
import { runningContextTool } from './running-context.js';
import { queryArtifactTool } from './query-artifact.js';
import { replProjectionTool } from './repl-projection.js';
import { defineContractTool } from './contract.js';
import type { OmnexxConfig } from '../config/schema.js';
import { workModeOf } from '../config/work-mode.js';
import * as extraSources from './extra/index.js';
import type { ToolSource, ToolWhere } from './extra/types.js';
import type { Tool } from './types.js';
import { createRequestToolsTool, type LoadedToolsState } from './request-tools.js';
import { TOOL_GROUPS, GROUP_PURPOSES } from './groups.js';

export const WORKER_TOOLS: readonly Tool[] = [
  readTool,
  outlineTool,
  readSymbolTool,
  searchTool,
  strReplaceTool,
  multiEditTool,
  replaceLinesTool,
  writeFileTool,
  bashTool,
  readLogTool,
  rememberTool,
  recallTool,
  taskTool,
  runningContextTool,
  queryArtifactTool,
  replProjectionTool,
  contextTool,
  todoTool,
  defineContractTool,
] as Tool[];

export const READ_ONLY_TOOLS: readonly Tool[] = WORKER_TOOLS.filter((t) => t.readOnly);

/**
 * Tools that only make sense on a codebase: AST/symbol navigation backed by the
 * TypeScript compiler (outline, read_symbol). Everything else in WORKER_TOOLS is
 * universal (files, search, bash, notes, artifacts) and loads in both work domains.
 * In the "general" domain these are suppressed: there is no AST to navigate, and
 * their schemas would only invite dead calls. (fsm-mask, ts-check, test-digest and
 * the AST cache are internal helpers of other tools, not exposed tools themselves.)
 */
export const CODE_ONLY_TOOLS: ReadonlySet<string> = new Set(['outline', 'read_symbol']);

/** Drop the code-only tools when the run's work domain is "general"; identity for "swe". */
export function forDomain(tools: readonly Tool[], config: OmnexxConfig): readonly Tool[] {
  if (workModeOf(config) !== 'general') return tools;
  return tools.filter((t) => !CODE_ONLY_TOOLS.has(t.name));
}

export interface ExposureOptions {
  /** `[context] subagents`: whether the worker may start `task` helper agents. */
  subagents: boolean;
  /** Whether earlier cycles left anything for `recall` to search (progress, evidence or lessons). */
  hasHistory: boolean;
  /**
   * `[policy] auto_approve`: whether an install can happen without a person. Without it an
   * unattended run can only suggest one, so the integrations tools are left out.
   */
  autoApprove?: boolean;
  /** `[context] lazy_tools`: serve the rarely called read-only tools through `more_tools`. */
  lazyTools?: boolean;
}

/**
 * Drops native tools that cannot do anything this cycle, so their JSON schemas stay out of the
 * cached prefix and the model isn't invited to call a dead tool. `read_log` is kept: `bash` may
 * return a cut log at any time and its output tells the model to page it.
 */
export function exposedTools(tools: readonly Tool[], opts: ExposureOptions): readonly Tool[] {
  const live = tools.filter((t) => {
    if (t.name === 'task') return opts.subagents;
    if (t.name === 'recall') return opts.hasHistory;
    if (t.name.startsWith('integrations_')) return opts.autoApprove === true;
    return true;
  });
  if (!opts.lazyTools) return live;
  const deferred = live.filter((t) => DEFERRED_TOOLS.has(t.name) && t.readOnly);
  if (!deferred.length) return live;
  return [...live.filter((t) => !deferred.includes(t)), moreToolsTool(deferred)];
}

const EXTRA_SOURCES: Record<string, ToolSource> = extraSources;

/** Core tools first, in their fixed order, then every extra source's tools sorted by name. */
export async function workerTools(
  config: OmnexxConfig,
  where?: ToolWhere,
  sources: Record<string, ToolSource> = EXTRA_SOURCES,
): Promise<readonly Tool[]> {
  const extra = (
    await Promise.all(Object.values(sources).map((s) => Promise.resolve(s.load(config, where))))
  ).flat();
  const core = new Set(WORKER_TOOLS.map((t) => t.name));
  const seen = new Set<string>();
  for (const t of extra) {
    if (core.has(t.name) || seen.has(t.name)) throw new Error(`duplicate tool name "${t.name}"`);
    seen.add(t.name);
  }
  return forDomain(
    [...WORKER_TOOLS, ...[...extra].sort((a, b) => (a.name < b.name ? -1 : 1))],
    config,
  );
}

export async function readOnlyTools(
  config: OmnexxConfig,
  where?: ToolWhere,
  sources?: Record<string, ToolSource>,
): Promise<readonly Tool[]> {
  return (await workerTools(config, where, sources)).filter((t) => t.readOnly);
}

/**
 * Build the tool list for a provider request, with lazy loading support.
 * In lazy mode, only tools from loaded groups + always-loaded tools are included.
 */
export async function buildToolList(
  config: OmnexxConfig,
  where: ToolWhere | undefined,
  exposureOpts: ExposureOptions,
  loadedState: LoadedToolsState | null,
): Promise<readonly Tool[]> {
  const allTools = await workerTools(config, where);
  return buildToolListSync(allTools, config, exposureOpts, loadedState);
}

/**
 * Synchronous version of buildToolList that takes pre-computed allTools.
 * Used for refreshTools in lazy mode to avoid re-fetching tools each turn.
 */
export function buildToolListSync(
  allTools: readonly Tool[],
  config: OmnexxConfig,
  exposureOpts: ExposureOptions,
  loadedState: LoadedToolsState | null,
): readonly Tool[] {
  // Lazy mode: filter to loaded groups + always-loaded
  if (config.tools.discovery === 'lazy' && loadedState) {
    const filtered = allTools.filter((tool) => {
      if (loadedState.toolToGroup.has(tool.name)) {
        const group = loadedState.toolToGroup.get(tool.name);
        return group ? loadedState.loadedGroups.has(group) : false;
      }
      // Tools not in any group (e.g., MCP tools) are loaded by default
      return true;
    });
    // Always include request_tools meta-tool in lazy mode
    const requestToolsTool = createRequestToolsTool(loadedState);
    return exposedTools([...filtered, requestToolsTool], exposureOpts);
  }

  // Full mode: all tools
  return exposedTools(allTools, exposureOpts);
}

/**
 * Build the compact tool index for lazy mode (shown in system prompt instead of full schemas).
 * Lists every group in TOOL_GROUPS, marking loaded groups. Optionally filters by availableToolNames.
 */
export function buildToolIndexForPrompt(
  loadedState: LoadedToolsState,
  availableToolNames?: ReadonlySet<string>,
): string {
  const lines: string[] = [
    'Call request_tools({groups:[...]}) to load full definitions for a group before using its tools. Groups marked loaded are ready.',
  ];
  for (const group of Object.keys(TOOL_GROUPS)) {
    const purpose = GROUP_PURPOSES[group] ?? '';
    const allToolsInGroup = TOOL_GROUPS[group] ?? [];
    const tools = allToolsInGroup.filter((t) => !availableToolNames || availableToolNames.has(t));
    if (!tools.length) continue;
    const loadedMarker = loadedState.loadedGroups.has(group) ? ' loaded' : '';
    lines.push(`- ${group} (${purpose})${loadedMarker}: ${tools.join(', ')}`);
  }
  return lines.join('\n');
}

/** JSON schema for the API, keys sorted so the cached prefix is byte-stable. */
export function toolSpec(tool: Tool): ToolSpec {
  const schema = z.toJSONSchema(tool.schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: sortKeys(schema) as Record<string, unknown>,
  };
}

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        // zod writes the safe-integer range on every int: tokens in every call, no constraint.
        .filter(
          (k) =>
            !(SAFE_BOUND[k] !== undefined && (v as Record<string, unknown>)[k] === SAFE_BOUND[k]),
        )
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

const SAFE_BOUND: Readonly<Record<string, number>> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};
