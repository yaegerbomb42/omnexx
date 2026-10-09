import { z } from 'zod';
import type { ToolSpec } from '../providers/types.js';
import { bashTool, readLogTool } from './bash.js';
import { multiEditTool, strReplaceTool, writeFileTool } from './edit.js';
import { outlineTool } from './outline.js';
import { readTool } from './read.js';
import { contextTool } from './context.js';
import { recallTool } from './recall.js';
import { todoTool } from './todo.js';
import { rememberTool } from './remember.js';
import { searchTool } from './search.js';
import { taskTool } from './task.js';
import { runningContextTool } from './running-context.js';
import type { OmnexxConfig } from '../config/schema.js';
import * as extraSources from './extra/index.js';
import type { ToolSource, ToolWhere } from './extra/types.js';
import type { Tool } from './types.js';

export const WORKER_TOOLS: readonly Tool[] = [
  readTool,
  outlineTool,
  searchTool,
  strReplaceTool,
  multiEditTool,
  writeFileTool,
  bashTool,
  readLogTool,
  rememberTool,
  recallTool,
  taskTool,
  runningContextTool,
  contextTool,
  todoTool,
] as Tool[];

export const READ_ONLY_TOOLS: readonly Tool[] = WORKER_TOOLS.filter((t) => t.readOnly);

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
  return [...WORKER_TOOLS, ...[...extra].sort((a, b) => (a.name < b.name ? -1 : 1))];
}

export async function readOnlyTools(
  config: OmnexxConfig,
  where?: ToolWhere,
  sources?: Record<string, ToolSource>,
): Promise<readonly Tool[]> {
  return (await workerTools(config, where, sources)).filter((t) => t.readOnly);
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
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
