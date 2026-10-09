import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialsDir, type OmnexxPaths } from '../core/paths.js';
import { UsageError } from '../errors.js';

/**
 * Any provider name (`anthropic`, `groq`, `openrouter`, ...) can hold a key.
 * `PROVIDERS` keeps the well-known default for help text; `assertProvider`
 * accepts any lowercase `name` so `auth set <any-provider>` works.
 */
export const PROVIDERS = ['anthropic'] as const;
export type KeyProvider = string;

export interface KeyLookup {
  key: string;
  source: string;
}

const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function keyFile(paths: OmnexxPaths, provider: KeyProvider): string {
  return join(credentialsDir(paths), `${provider}.key`);
}

/** Any lowercase provider name; rejects empty/uppercase/path-like input. */
export function assertProvider(name: string): KeyProvider {
  if (NAME_RE.test(name)) return name;
  throw new UsageError(
    `unknown provider "${name}"`,
    'use a lowercase name like anthropic, groq or openrouter',
  );
}

export function envNames(provider: string): { omnexx: string; plain: string } {
  const upper = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return { omnexx: `OMNEXX_${upper}_API_KEY`, plain: `${upper}_API_KEY` };
}

/**
 * Lookup order: OMNEXX_<NAME>_API_KEY, the endpoint's api_key_env, then the
 * 0600 credentials file. Never touches keychains or other tools' logins.
 * Keeps Anthropic's historical behaviour (OMNEXX_ANTHROPIC_API_KEY, then
 * ANTHROPIC_API_KEY, then file).
 */
export async function findProviderKey(
  paths: OmnexxPaths,
  env: NodeJS.ProcessEnv,
  provider: string,
  apiKeyEnv?: string,
): Promise<KeyLookup | undefined> {
  const names = envNames(provider);
  // Lookup order: OMNEXX_<NAME>_API_KEY, the endpoint's api_key_env, the
  // credentials file. api_key_env usually equals one of the first two.
  const candidates = [names.omnexx];
  if (apiKeyEnv) candidates.push(apiKeyEnv);
  if (!candidates.includes(names.plain)) candidates.push(names.plain);
  for (const name of candidates) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: name };
  }
  try {
    const stored = (await readFile(keyFile(paths, provider), 'utf8')).trim();
    return stored ? { key: stored, source: 'credentials file' } : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Env first (OMNEXX_ wins), then the 0600 credentials file. Never touches keychains or other tools' logins. */
export async function findAnthropicKey(
  paths: OmnexxPaths,
  env: NodeJS.ProcessEnv,
): Promise<KeyLookup | undefined> {
  return findProviderKey(paths, env, 'anthropic');
}

export async function storeKey(
  paths: OmnexxPaths,
  provider: KeyProvider,
  key: string,
): Promise<string> {
  assertProvider(provider);
  const trimmed = key.trim();
  if (!trimmed) throw new UsageError('empty key', 'paste the key, then press Enter');
  const dir = credentialsDir(paths);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = keyFile(paths, provider);
  await writeFile(file, `${trimmed}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export async function clearKey(paths: OmnexxPaths, provider: KeyProvider): Promise<boolean> {
  assertProvider(provider);
  try {
    await rm(keyFile(paths, provider));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** `sk-ant-…wxyz`: enough to recognise which key it is, never enough to use it. */
export function maskKey(key: string): string {
  const m = /^(sk-ant-|sk-)/.exec(key)?.[0] ?? '';
  const tail = key.length >= 12 ? key.slice(-4) : '';
  return `${m}…${tail}`;
}
