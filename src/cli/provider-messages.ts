import type { ApiFlavor } from '../providers/catalog.js';

export interface ProviderExtras {
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  flavor?: ApiFlavor;
}

/**
 * The optional parts of an addProvider / probeProvider message from the settings page: templated
 * URL values, extra headers and a forced API flavor. Anything malformed is dropped, not trusted.
 */
export function providerExtras(c: Readonly<Record<string, unknown>>): ProviderExtras {
  const fields = stringMap(c.fields);
  const headers = stringMap(c.headers);
  return {
    ...(fields ? { fields } : {}),
    ...(headers ? { headers } : {}),
    ...(isFlavor(c.flavor) ? { flavor: c.flavor } : {}),
  };
}

const FLAVORS: readonly ApiFlavor[] = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];

export function isFlavor(v: unknown): v is ApiFlavor {
  return typeof v === 'string' && (FLAVORS as readonly string[]).includes(v);
}

/** A string map from untrusted input (a webview message, CLI flags); others are dropped. */
export function stringMap(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '',
  );
  return entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, v.trim()])) : undefined;
}
