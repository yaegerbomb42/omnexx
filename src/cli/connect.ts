import { storeKey, findProviderKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths, userConfigFile } from '../core/paths.js';
import { UsageError } from '../errors.js';
import { discoverModels } from '../providers/discovery.js';
import {
  appendEndpointBlock,
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
} from './commands/providers.js';
import type { CliIO } from './io.js';

/** Key prefixes that name their provider. Order matters: longer prefixes first. */
const KEY_PREFIXES: readonly (readonly [string, string])[] = [
  ['sk-ant-', 'anthropic'],
  ['sk-or-', 'openrouter'],
  ['gsk_', 'groq'],
  ['xai-', 'xai'],
  ['AIza', 'gemini'],
  ['fw_', 'fireworks'],
  ['sk-', 'openai'],
];

/** The provider a pasted key belongs to, or undefined when it doesn't look like a key. */
export function providerForKey(text: string): string | undefined {
  const t = text.trim();
  if (/\s/.test(t) || t.length < 20) return undefined;
  return KEY_PREFIXES.find(([p]) => t.startsWith(p))?.[1];
}

export function looksLikeKey(text: string): boolean {
  return providerForKey(text) !== undefined;
}

/** A name for an endpoint URL: a matching template, else the host's distinctive label. */
export function nameForUrl(url: string): string {
  const u = new URL(url);
  for (const [name, t] of Object.entries(PROVIDER_TEMPLATES)) {
    if (name === 'custom') continue;
    const tu = new URL(t.baseUrl);
    if (tu.host === u.host) return name;
  }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return 'local';
  const labels = u.hostname.split('.').filter((l) => !['api', 'www', 'inference'].includes(l));
  const label = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  return (label ?? 'custom').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

export interface ConnectResult {
  name: string;
  added: boolean;
  keyStored: boolean;
  models: string[];
  /** A ready-to-use model ref, e.g. "openrouter:deepseek/deepseek-v4". */
  suggested: string | undefined;
  notes: string[];
}

/**
 * One step from nothing to a usable provider. `target` is a provider name ("openrouter"), a base
 * URL ("http://localhost:11434/v1"), or a pasted API key. The key goes to the 0600 credentials
 * file, the endpoint to user config, and the endpoint's models are listed to prove it works.
 */
export async function connect(
  io: CliIO,
  target: string,
  key?: string,
  opts: { name?: string } = {},
): Promise<ConnectResult> {
  let t = target.trim();
  let k = key?.trim() ? key.trim() : undefined;
  if (!t) throw new UsageError('nothing to connect', 'try `connect openrouter <key>` or a URL');
  const keyProvider = providerForKey(t);
  if (keyProvider && !k) {
    k = t;
    t = keyProvider;
  }
  let name: string;
  let template: ProviderTemplate | undefined;
  if (/^https?:\/\//i.test(t)) {
    name = opts.name ?? nameForUrl(t);
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(t);
    template = { baseUrl: t, keyEnv: undefined, free: local && !k, kind: 'openai' };
  } else {
    name = (opts.name ?? t).toLowerCase();
    template = PROVIDER_TEMPLATES[name];
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(name))
    throw new UsageError(`bad provider name "${name}"`, 'use lowercase letters, digits, _ or -');

  const paths = resolvePaths(io.env);
  const notes: string[] = [];
  let keyStored = false;
  if (k) {
    await storeKey(paths, name, k);
    keyStored = true;
  }
  if (name === 'anthropic') {
    const found = await findProviderKey(paths, io.env, 'anthropic');
    if (!found) notes.push('no Anthropic key yet: paste one (sk-ant-…)');
    return {
      name,
      added: false,
      keyStored,
      models: ['opus', 'sonnet', 'haiku'],
      suggested: found ? 'anthropic:sonnet' : undefined,
      notes,
    };
  }

  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const existing = config.providers.endpoints[name];
  let added = false;
  let baseUrl = existing?.base_url;
  if (!existing) {
    if (!template)
      throw new UsageError(
        `unknown provider "${name}"`,
        `known: ${Object.keys(PROVIDER_TEMPLATES).join(', ')}; or connect a base URL`,
      );
    // Keys live in the credentials file, so the endpoint doesn't need an env var.
    await appendEndpointBlock(userConfigFile(paths), name, { ...template, keyEnv: undefined });
    baseUrl = template.baseUrl;
    added = true;
  }
  const apiKey = (await findProviderKey(paths, io.env, name, existing?.api_key_env))?.key;
  if (!apiKey && !(existing?.free ?? template?.free)) notes.push(`no key for ${name} yet`);
  const local = /localhost|127\.0\.0\.1/.test(baseUrl ?? '');
  const models = baseUrl
    ? (
        await discoverModels(
          { baseUrl, ...(apiKey ? { apiKey } : {}) },
          io.fetch ? { fetch: io.fetch } : {},
        )
      ).map((m) => m.id)
    : [];
  if (!models.length)
    notes.push(
      local
        ? `nothing answered at ${baseUrl}; is the server running?`
        : `couldn't list models at ${baseUrl}; check the key`,
    );
  const first = models[0];
  return {
    name,
    added,
    keyStored,
    models,
    suggested: first ? `${name}:${first}` : undefined,
    notes,
  };
}

export function describeConnect(r: ConnectResult): string {
  const lines = [
    `${r.added ? 'added' : 'updated'} ${r.name}${r.keyStored ? ' (key saved, 0600)' : ''}`,
  ];
  if (r.models.length) {
    const shown = r.models.slice(0, 8).join(', ');
    lines.push(
      `${r.models.length} model${r.models.length === 1 ? '' : 's'}: ${shown}${r.models.length > 8 ? ', …' : ''}`,
    );
  }
  for (const n of r.notes) lines.push(n);
  if (r.suggested) lines.push(`chat with it: /model ${r.suggested}`);
  return lines.join('\n');
}
