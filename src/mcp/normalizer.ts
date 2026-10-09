import { sortKeys } from '../tools/registry.js';
import { CHARS_PER_TOKEN } from '../core/tokens.js';

export const MAX_MCP_TEXT_TOKENS = 8000;
const MAX_TEXT_CHARS = MAX_MCP_TEXT_TOKENS * CHARS_PER_TOKEN;

/**
 * Normalizes tool names into standard mcp__<server>__<tool> identifier.
 */
export function formatMcpToolName(serverName: string, toolName: string): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${sanitize(serverName)}__${sanitize(toolName)}`;
}

/**
 * Trims text output deterministically to 8000 tokens (similar to bash head/tail strategy)
 */
export function trimMcpOutput(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const headChars = Math.floor(MAX_TEXT_CHARS * 0.3);
  const tailChars = Math.floor(MAX_TEXT_CHARS * 0.7);
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n… [${omitted} characters omitted due to token cap] …\n${text.slice(-tailChars)}`;
}

/**
 * Normalizes JSON Schema for an MCP tool, stripping $schema and sorting all keys recursively.
 */
export function normalizeMcpSchema(inputSchema: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const cloned = JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown>;
  delete cloned.$schema;
  cloned.type ??= 'object';
  return sortKeys(cloned) as Record<string, unknown>;
}
