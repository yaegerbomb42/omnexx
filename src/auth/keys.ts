import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialsDir, type OmnexxPaths } from '../core/paths.js';
import { UsageError } from '../errors.js';

export const PROVIDERS = ['anthropic'] as const;
export type KeyProvider = (typeof PROVIDERS)[number];

export interface KeyLookup {
  key: string;
  source: 'OMNEXX_ANTHROPIC_API_KEY' | 'ANTHROPIC_API_KEY' | 'credentials file';
}

export function keyFile(paths: OmnexxPaths, provider: KeyProvider): string {
  return join(credentialsDir(paths), `${provider}.key`);
}

export function assertProvider(name: string): KeyProvider {
  if ((PROVIDERS as readonly string[]).includes(name)) return name as KeyProvider;
  throw new UsageError(`unknown provider "${name}"`, `supported: ${PROVIDERS.join(', ')}`);
}

/** Env first (OMNEXX_ wins), then the 0600 credentials file. Never touches keychains or other tools' logins. */
export async function findAnthropicKey(
  paths: OmnexxPaths,
  env: NodeJS.ProcessEnv,
): Promise<KeyLookup | undefined> {
  const fromOmnexx = env.OMNEXX_ANTHROPIC_API_KEY?.trim();
  if (fromOmnexx) return { key: fromOmnexx, source: 'OMNEXX_ANTHROPIC_API_KEY' };
  const fromEnv = env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'ANTHROPIC_API_KEY' };
  try {
    const stored = (await readFile(keyFile(paths, 'anthropic'), 'utf8')).trim();
    return stored ? { key: stored, source: 'credentials file' } : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function storeKey(
  paths: OmnexxPaths,
  provider: KeyProvider,
  key: string,
): Promise<string> {
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
  const prefix = /^(sk-ant-|sk-)/.exec(key)?.[0] ?? '';
  const tail = key.length >= 12 ? key.slice(-4) : '';
  return `${prefix}…${tail}`;
}
