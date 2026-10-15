import { storeKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths, userConfigFile } from '../core/paths.js';
import { UsageError } from '../errors.js';
import type { EndpointAuth } from '../providers/auth-headers.js';
import {
  catalogEntry,
  endpointAuth,
  fillBaseUrl,
  kindForFlavor,
  modelsUrlFor,
  type ApiFlavor,
  type CatalogEntry,
} from '../providers/catalog.js';
import { discoverModels } from '../providers/discovery.js';
import { authHeaders } from '../providers/auth-headers.js';
import { probeEndpoint, type ProbeInput, type ProbeResult } from '../providers/probe.js';
import { appendEndpointBlock, removeEndpointBlock } from './commands/providers.js';
import { nameForUrl } from './connect.js';
import type { CliIO } from './io.js';

export { isFlavor, stringMap } from './provider-messages.js';

/**
 * Setting up a provider from the catalog (filling templated URLs like Azure's) or from just a base
 * URL and a key (the custom flow: flavor detected by probing). Used by the settings page, the
 * `omnexx providers add` command and `/provider` in the TUI.
 */

export interface SetupRequest {
  /** A catalog id, or the name to save a custom endpoint under. */
  provider?: string | undefined;
  url?: string | undefined;
  key?: string | undefined;
  /** Values for a templated base URL, e.g. { resource: 'my-azure' }. */
  fields?: Readonly<Record<string, string>> | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  /** Force an API flavor instead of detecting it. */
  flavor?: ApiFlavor | undefined;
  auth?: EndpointAuth | undefined;
}

export interface SetupResult {
  name: string;
  probe: ProbeResult;
  message: string;
}

const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i;

/** Parse `Name: value` lines (or `k=v` flags) into headers; throws on a bad header name. */
export function parseHeaders(lines: readonly string[]): Record<string, string> | undefined {
  const pairs = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l): [string, string] => {
      const cut = l.search(/[:=]/);
      if (cut < 1) throw new UsageError(`"${l}" is not a header`, 'write it as Name: value');
      return [l.slice(0, cut).trim(), l.slice(cut + 1).trim()];
    });
  for (const [k] of pairs)
    if (!HEADER_NAME.test(k)) throw new UsageError(`"${k}" is not a usable header name`);
  return pairs.length ? Object.fromEntries(pairs) : undefined;
}

interface Target {
  name: string;
  entry: CatalogEntry | undefined;
  baseUrl: string;
  auth: EndpointAuth | undefined;
}

function resolveTarget(req: SetupRequest): Target {
  const id = req.provider?.trim().toLowerCase();
  const url = req.url?.trim();
  if (id && !NAME.test(id))
    throw new UsageError(`"${id}" is not a usable name`, 'lowercase letters, digits, _ and -');
  const entry = id ? catalogEntry(id) : undefined;
  if (url && !/^https?:\/\/\S+$/i.test(url))
    throw new UsageError('the URL must start with http:// or https://');
  let baseUrl: string;
  try {
    baseUrl = url ?? (entry ? fillBaseUrl(entry, req.fields ?? {}) : '');
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (!baseUrl) throw new UsageError(`unknown provider "${id ?? ''}"`, 'give its base URL');
  const name = id ?? nameForUrl(baseUrl);
  if (!NAME.test(name)) throw new UsageError(`bad provider name "${name}"`);
  const auth = req.auth ?? (entry ? (endpointAuth(entry.auth) ?? 'bearer') : undefined);
  return { name, entry, baseUrl, auth: auth === 'bearer' ? undefined : auth };
}

/** List a catalog provider's models directly: its flavor is known, so no probing. */
async function checkCatalog(io: CliIO, t: Target, req: SetupRequest): Promise<ProbeResult> {
  const entry = t.entry;
  if (!entry || entry.flavor === 'anthropic' || entry.flavor === 'gemini')
    return probeEndpoint({ ...probeBase(io, t, req), flavor: entry?.flavor });
  const listUrl = modelsUrlFor(entry, t.baseUrl);
  const headers = authHeaders(req.key, t.auth, req.headers);
  const models = listUrl
    ? await discoverModels(
        { baseUrl: t.baseUrl, headers, modelsUrl: listUrl },
        io.fetch ? { fetch: io.fetch } : {},
      )
    : [];
  if (models.length || !listUrl)
    return {
      ok: true,
      flavor: entry.flavor,
      baseUrl: t.baseUrl,
      models: models.map((m) => m.id),
      detail: models.length ? `${models.length} models` : 'saved (it has no model list)',
    };
  // The list failed: probe to say why (401, 404, unreachable).
  const why = await probeEndpoint({ ...probeBase(io, t, req), flavor: entry.flavor });
  return why.ok ? why : { ...why, baseUrl: t.baseUrl };
}

function probeBase(io: CliIO, t: Target, req: SetupRequest): ProbeInput {
  const key = req.key?.trim();
  return {
    baseUrl: t.baseUrl,
    apiKey: key === '' ? undefined : key,
    auth: t.auth,
    headers: req.headers,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  };
}

/** Check an endpoint without saving anything: the settings form's Test button. */
export async function probeProvider(io: CliIO, req: SetupRequest): Promise<ProbeResult> {
  const t = resolveTarget(req);
  if (t.entry && !req.url) return checkCatalog(io, t, req);
  return probeEndpoint({ ...probeBase(io, t, req), flavor: req.flavor });
}

/**
 * Save a provider: probe it, then write its endpoint block (kind, auth, headers) and store the
 * key (0600). A remote endpoint that fails the probe is not saved; a local one is (the server
 * may simply not be running yet).
 */
export async function setupProvider(io: CliIO, req: SetupRequest): Promise<SetupResult> {
  const t = resolveTarget(req);
  const probe = await probeProvider(io, req);
  const local = LOCAL_URL.test(t.baseUrl);
  if (!probe.ok && !local) throw new UsageError(`${t.name}: ${probe.detail}`);
  const flavor = req.flavor ?? (probe.ok ? probe.flavor : undefined) ?? t.entry?.flavor;
  const paths = resolvePaths(io.env);
  const file = userConfigFile(paths);
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  if (config.providers.endpoints[t.name]) await removeEndpointBlock(file, t.name);
  await appendEndpointBlock(file, t.name, {
    baseUrl: probe.ok ? probe.baseUrl : t.baseUrl,
    keyEnv: undefined,
    free: local && !req.key,
    kind: kindForFlavor(flavor ?? 'openai-chat'),
    ...(t.auth ? { auth: t.auth } : {}),
    ...(req.headers ? { headers: { ...req.headers } } : {}),
  });
  const key = req.key?.trim();
  if (key) await storeKey(paths, t.name, key);
  return { name: t.name, probe, message: describeSetup(t.name, probe, Boolean(key)) };
}

export function describeSetup(name: string, probe: ProbeResult, keyStored: boolean): string {
  const lines = [`added ${name}${keyStored ? ' (key saved, 0600)' : ''}`, probe.detail];
  const first = probe.models[0];
  if (probe.models.length)
    lines.push(
      `models: ${probe.models.slice(0, 8).join(', ')}${probe.models.length > 8 ? ', …' : ''}`,
    );
  if (first) lines.push(`chat with it: /model ${name}:${first}`);
  return lines.join('\n');
}

/** Whether a request needs the catalog/custom flow rather than the plain connect() path. */
export function needsSetup(req: SetupRequest): boolean {
  const entry = req.provider ? catalogEntry(req.provider) : undefined;
  const customUrl = Boolean(req.url) && !(req.url && LOCAL_URL.test(req.url));
  const extras = [req.fields, req.headers, req.flavor, req.auth].some((v) => v !== undefined);
  return extras || (entry !== undefined && entry.fields.length > 0) || (customUrl && !entry);
}
