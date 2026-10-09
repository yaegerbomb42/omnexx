import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Secret values for MCP servers (tokens from an import, an API key asked for at install), kept
 * out of config.toml in a 0600 JSON file: `{ "<server>": { "<KEY>": "<value>" } }`. The config
 * refers to them by name only.
 */
export type McpSecrets = Record<string, Record<string, string>>;

export const secretsFile = (configHome: string): string => join(configHome, 'mcp-secrets.json');

export async function readSecrets(configHome: string): Promise<McpSecrets> {
  try {
    const parsed: unknown = JSON.parse(await readFile(secretsFile(configHome), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as McpSecrets) : {};
  } catch {
    return {};
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
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** How the config names a stored secret: `secret:<KEY>` in an env or header value. */
export const SECRET_PREFIX = 'secret:';
