import { clearKey, findProviderKey, maskKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths, userConfigFile } from '../core/paths.js';
import { UsageError } from '../errors.js';
import { PROVIDER_TEMPLATES, removeEndpointBlock } from './commands/providers.js';
import { connect, describeConnect } from './connect.js';
import type { CliIO } from './io.js';

/**
 * Provider settings for editor panels (`omnexx chat-server`): what can be added, what is set up,
 * and adding or removing one. Keys go to the 0600 credentials file and are only ever shown masked.
 */

export interface CatalogProvider {
  name: string;
  label: string;
  baseUrl: string;
  /** A local server the person runs themselves: no key. */
  local: boolean;
  /** Where to get a key. */
  signup?: string;
  /** How its keys start, for a placeholder. */
  keyPrefix?: string;
}

export interface ConnectedProvider {
  name: string;
  label: string;
  baseUrl: string;
  local: boolean;
  free: boolean;
  /** The key, masked (`sk-…wxyz`), or null when none is set. */
  key: string | null;
  /** Where the key comes from: an environment variable or the credentials file. */
  keySource: string | null;
}

export interface ProviderSettings {
  catalog: CatalogProvider[];
  connected: ConnectedProvider[];
}

const ANTHROPIC: CatalogProvider = {
  name: 'anthropic',
  label: 'Anthropic (Claude)',
  baseUrl: 'https://api.anthropic.com',
  local: false,
  signup: 'https://console.anthropic.com/settings/keys',
  keyPrefix: 'sk-ant-',
};

const NAME = /^[a-z][a-z0-9_-]{0,39}$/;

export function providerCatalog(): CatalogProvider[] {
  const listed = Object.entries(PROVIDER_TEMPLATES)
    .filter(([name]) => name !== 'custom')
    .map(([name, t]) => ({
      name,
      label: t.label ?? name,
      baseUrl: t.baseUrl,
      local: t.local === true,
      ...(t.signup ? { signup: t.signup } : {}),
      ...(t.keyPrefix ? { keyPrefix: t.keyPrefix } : {}),
    }));
  return [ANTHROPIC, ...listed];
}

export async function providerSettings(io: CliIO): Promise<ProviderSettings> {
  const paths = resolvePaths(io.env);
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const catalog = providerCatalog();
  const labelOf = (name: string): string => catalog.find((c) => c.name === name)?.label ?? name;
  const connected: ConnectedProvider[] = [];
  const anthropic = await findProviderKey(paths, io.env, 'anthropic');
  if (anthropic)
    connected.push({
      name: 'anthropic',
      label: ANTHROPIC.label,
      baseUrl: ANTHROPIC.baseUrl,
      local: false,
      free: false,
      key: maskKey(anthropic.key),
      keySource: anthropic.source,
    });
  for (const [name, ep] of Object.entries(config.providers.endpoints)) {
    const found = await findProviderKey(paths, io.env, name, ep.api_key_env);
    connected.push({
      name,
      label: labelOf(name),
      baseUrl: ep.base_url,
      local:
        PROVIDER_TEMPLATES[name]?.local === true ||
        /\/\/(localhost|127\.0\.0\.1)[:/]/.test(ep.base_url),
      free: ep.free,
      key: found ? maskKey(found.key) : null,
      keySource: found?.source ?? null,
    });
  }
  return { catalog, connected };
}

export interface AddProvider {
  /** A catalog name, or a new name for a custom URL. */
  provider?: string | undefined;
  key?: string | undefined;
  /** For a custom or local OpenAI-compatible server. */
  url?: string | undefined;
}

/** Connect a provider from the settings form; returns what to tell the person. */
export async function addProvider(io: CliIO, a: AddProvider): Promise<string> {
  const url = a.url?.trim();
  const provider = a.provider?.trim().toLowerCase();
  const key = a.key?.trim() ? a.key.trim() : undefined;
  if (url && !/^https?:\/\/\S+$/i.test(url))
    throw new UsageError('the URL must start with http:// or https://');
  if (provider && !NAME.test(provider))
    throw new UsageError(
      `"${provider}" is not a usable name`,
      'lowercase letters, digits, _ and -',
    );
  if (!url && !provider && !key) throw new UsageError('pick a provider or enter a URL');
  // A catalog provider is connected by name; a URL gets the name it was given, if any.
  const target = url ?? provider ?? key ?? '';
  const r = await connect(io, target, url ? key : target === key ? undefined : key, {
    ...(url && provider ? { name: provider } : {}),
  });
  return describeConnect(r);
}

/** Remove a provider: its endpoint block and its stored key. Environment variables stay. */
export async function removeProvider(io: CliIO, name: string): Promise<string> {
  const lower = name.trim().toLowerCase();
  if (!NAME.test(lower)) throw new UsageError(`"${name}" is not a provider name`);
  const paths = resolvePaths(io.env);
  const removedBlock =
    lower === 'anthropic' ? false : await removeEndpointBlock(userConfigFile(paths), lower);
  const removedKey = await clearKey(paths, lower);
  if (!removedBlock && !removedKey)
    return `${lower} had nothing to remove (a key from an environment variable stays set)`;
  return `removed ${lower}${removedKey ? ' and its stored key' : ''}`;
}

export interface ProviderTest {
  name: string;
  ok: boolean;
  /** How many models the provider listed, when it answered. */
  models: number;
  detail: string;
}

const TEST_TIMEOUT_MS = 8_000;

/**
 * Check a provider from the settings page: list its models with the stored key. Anthropic is
 * built in and has no list endpoint here, so it only reports whether a key is set.
 */
export async function testProvider(io: CliIO, name: string): Promise<ProviderTest> {
  const lower = name.trim().toLowerCase();
  if (!NAME.test(lower)) throw new UsageError(`"${name}" is not a provider name`);
  const paths = resolvePaths(io.env);
  if (lower === 'anthropic') {
    const found = await findProviderKey(paths, io.env, 'anthropic');
    return {
      name: lower,
      ok: found !== undefined,
      models: found ? 3 : 0,
      detail: found ? 'key set (opus, sonnet, haiku)' : 'no key set',
    };
  }
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const ep = config.providers.endpoints[lower];
  if (!ep) return { name: lower, ok: false, models: 0, detail: 'not set up' };
  const key = (await findProviderKey(paths, io.env, lower, ep.api_key_env))?.key;
  const { discoverModels } = await import('../providers/discovery.js');
  const models = await discoverModels(
    { baseUrl: ep.base_url, ...(key ? { apiKey: key } : {}) },
    { timeoutMs: TEST_TIMEOUT_MS, ...(io.fetch ? { fetch: io.fetch } : {}) },
  );
  if (models.length)
    return { name: lower, ok: true, models: models.length, detail: `${models.length} models` };
  return {
    name: lower,
    ok: false,
    models: 0,
    detail: key || ep.free ? "couldn't reach it or it listed no models" : 'no key set',
  };
}
