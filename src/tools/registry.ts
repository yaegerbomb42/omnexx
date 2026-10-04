import { z } from 'zod';
import type { ToolSpec } from '../providers/types.js';
import { bashTool, readLogTool } from './bash.js';
import { multiEditTool, strReplaceTool, writeFileTool } from './edit.js';
import { outlineTool } from './outline.js';
import { readTool } from './read.js';
import { rememberTool } from './remember.js';
import { searchTool } from './search.js';
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
] as Tool[];

export const READ_ONLY_TOOLS: readonly Tool[] = WORKER_TOOLS.filter((t) => t.readOnly);

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
