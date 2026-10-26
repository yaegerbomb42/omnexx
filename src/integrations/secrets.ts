import { chmod, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../core/atomic.js';

/**
 * Secret values for MCP servers (tokens from an import, an API key asked for at install), kept
 * out of config.toml in a 0600 JSON file: `{ "<server>": { "<KEY>": "<value>" } }`. The config
 * refers to them by name only.
 */
export type McpSecrets = Record<string, Record<string, string>>;

export const secretsFile = (configHome: string): string => join(configHome, 'mcp-secrets.json');

export async function readSecrets(configHome: string): Promise<McpSecrets> {
  const file = secretsFile(configHome);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as McpSecrets) : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      try {
        await rename(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        // best-effort backup: still throw the original parse error
      }
    }
    throw err;
  }
}

/** Store (or, with an empty record, drop) one server's secrets. */
export async function writeServerSecrets(
  configHome: string,
  server: string,
  values: Record<string, string>,
): Promise<void> {
  const { [server]: current, ...rest } = await readSecrets(configHome);
  const all: McpSecrets = Object.keys(values).length
    ? { ...rest, [server]: { ...current, ...values } }
    : rest;
  const file = secretsFile(configHome);
  await writeJsonAtomic(file, all);
  await chmod(file, 0o600);
}

/** How the config names a stored secret: `secret:<KEY>` in an env or header value. */
export const SECRET_PREFIX = 'secret:';
