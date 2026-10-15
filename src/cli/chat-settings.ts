import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse } from 'smol-toml';
import { clearKey, findProviderKey, maskKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths, userConfigFile } from '../core/paths.js';
import { UsageError } from '../errors.js';
import { setTable, type TomlValue } from '../integrations/toml-edit.js';
import { PROVIDER_TEMPLATES, removeEndpointBlock } from './commands/providers.js';
import { connect, describeConnect } from './connect.js';
import { needsSetup, setupProvider } from './provider-setup.js';
import { PROVIDER_CATALOG, type ApiFlavor, type CatalogField } from '../providers/catalog.js';
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
  /** Values its base URL needs (Azure resource, AWS region, …), shown as form fields. */
  fields?: readonly CatalogField[];
  flavor?: ApiFlavor;
  freeTier?: boolean;
  keyEnvs?: readonly string[];
  docs?: string;
  note?: string;
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

const ANTHROPIC = {
  name: 'anthropic',
  label: 'Anthropic (Claude)',
  baseUrl: 'https://api.anthropic.com',
};

const NAME = /^[a-z][a-z0-9_-]{0,39}$/;

/** Every catalog provider, for the settings gallery (src/providers/catalog.ts). */
export function providerCatalog(): CatalogProvider[] {
  return PROVIDER_CATALOG.map((e) => ({
    name: e.id,
    label: e.name,
    baseUrl: e.baseUrl,
    local: e.local,
    flavor: e.flavor,
    freeTier: e.freeTier,
    keyEnvs: e.keyEnvs,
    ...(e.fields.length ? { fields: e.fields } : {}),
    ...(e.signup ? { signup: e.signup } : {}),
    ...(e.keyPrefix ? { keyPrefix: e.keyPrefix } : {}),
    ...(e.docs ? { docs: e.docs } : {}),
    ...(e.note ? { note: e.note } : {}),
  }));
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
  /** Templated base URL values, extra headers, a forced flavor: see provider-setup.ts. */
  fields?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  flavor?: ApiFlavor | undefined;
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
  if (needsSetup({ ...a, url, provider }))
    return (await setupProvider(io, { ...a, url, provider, key })).message;
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
  if (!key && !ep.free && ep.auth !== 'none')
    return { name: lower, ok: false, models: 0, detail: 'no key set' };
  const { discoverModels } = await import('../providers/discovery.js');
  const { authHeaders } = await import('../providers/auth-headers.js');
  const models =
    ep.kind === 'openai' || ep.kind === 'responses'
      ? await discoverModels(
          { baseUrl: ep.base_url, headers: authHeaders(key, ep.auth, ep.headers) },
          { timeoutMs: TEST_TIMEOUT_MS, ...(io.fetch ? { fetch: io.fetch } : {}) },
        )
      : [];
  if (models.length)
    return { name: lower, ok: true, models: models.length, detail: `${models.length} models` };
  // No list: probe to say why in words a person can act on ("401: key rejected", "404: …/v1").
  const { probeEndpoint } = await import('../providers/probe.js');
  const probe = await probeEndpoint({
    baseUrl: ep.base_url,
    apiKey: key,
    auth: ep.auth,
    headers: ep.headers,
    flavor: ep.kind === 'anthropic' || ep.kind === 'gemini' ? ep.kind : undefined,
    timeoutMs: TEST_TIMEOUT_MS,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  return { name: lower, ok: probe.ok, models: probe.models.length, detail: probe.detail };
}

/** The browser tool's engine, profile and session, as the settings page shows and saves them. */
export interface BrowserSettings {
  engine: 'chromium' | 'camoufox';
  /** A folder (or Chrome profile name) whose logins the agent reuses; null when unset. */
  profile: string | null;
  sessionName: string | null;
  headless: boolean;
}

const ENGINES = ['chromium', 'camoufox'] as const;
// Same rule as browser.session_name in src/config/sections/browser.ts.
const SESSION_NAME = /^[\w.-]{1,64}$/;
/** C0 and C1 control characters, newlines included. */
const hasControl = (text: string): boolean =>
  Array.from(text).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

export async function browserSettings(io: CliIO): Promise<BrowserSettings> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const b = config.browser;
  return {
    engine: b.engine,
    profile: b.profile ?? null,
    sessionName: b.session_name ?? null,
    headless: b.headless,
  };
}

/** A trimmed optional text field: empty is unset; newlines and control characters are refused. */
function optionalText(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new UsageError(`${label} must be text`);
  const trimmed = raw.trim();
  if (hasControl(trimmed))
    throw new UsageError(`${label} can't contain newlines or control characters`);
  return trimmed || undefined;
}

/** Check what the settings form sent; throws a UsageError naming the bad field. */
export function parseBrowserSettings(raw: unknown): BrowserSettings {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const engine = obj.engine ?? 'chromium';
  if (typeof engine !== 'string' || !(ENGINES as readonly string[]).includes(engine))
    throw new UsageError('the browser engine must be chromium or camoufox');
  const profile = optionalText(obj.profile, 'the browser profile');
  const sessionName = optionalText(obj.sessionName, 'the session name');
  if (sessionName && !SESSION_NAME.test(sessionName))
    throw new UsageError(
      `"${sessionName}" is not a usable session name`,
      'up to 64 letters, digits, _ . and -',
    );
  if (obj.headless !== undefined && typeof obj.headless !== 'boolean')
    throw new UsageError('headless must be on or off');
  return {
    engine: engine as BrowserSettings['engine'],
    profile: profile ?? null,
    sessionName: sessionName ?? null,
    headless: obj.headless !== false,
  };
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** The [browser] keys already in the user config, kept when the form saves its four. */
function existingBrowser(text: string): Record<string, TomlValue> {
  const table = (parse(text) as Record<string, unknown>).browser;
  return typeof table === 'object' && table !== null ? (table as Record<string, TomlValue>) : {};
}

/** Save the browser settings to the user's config.toml; other [browser] keys stay as they were. */
export async function setBrowserSettings(io: CliIO, raw: unknown): Promise<BrowserSettings> {
  const next = parseBrowserSettings(raw);
  const file = userConfigFile(resolvePaths(io.env));
  const text = await readText(file);
  const updated = setTable(text, ['browser'], {
    ...existingBrowser(text),
    engine: next.engine,
    profile: next.profile ?? undefined,
    session_name: next.sessionName ?? undefined,
    headless: next.headless,
  });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, updated, 'utf8');
  return next;
}
