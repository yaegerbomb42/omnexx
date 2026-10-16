/** Catalog entry shapes and the builders the catalog files share. */

/** The wire API an endpoint speaks. */
export type ApiFlavor = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';

/**
 * How the key is sent. `bearer`: Authorization: Bearer; `api-key`: an `api-key` header (Azure);
 * `x-api-key`: Anthropic style; `x-goog-api-key`: Gemini; `none`: no key (local servers).
 */
export type AuthStyle = 'bearer' | 'api-key' | 'x-api-key' | 'x-goog-api-key' | 'none';

/** A value the base URL needs, e.g. an Azure resource name; `{key}` in baseUrl is replaced. */
export interface CatalogField {
  key: string;
  label: string;
  placeholder: string;
  default?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  /** May contain `{field}` placeholders, filled from `fields`. */
  baseUrl: string;
  fields: readonly CatalogField[];
  auth: AuthStyle;
  /** Standard env vars holding the key, most common first. Empty for keyless servers. */
  keyEnvs: readonly string[];
  /** How its keys start, so a pasted key is recognised. */
  keyPrefix?: string;
  flavor: ApiFlavor;
  /** Path of the model list relative to the base URL; null when the provider has none. */
  modelsPath: string | null;
  /** Has a free tier (hosted) or costs nothing (local). */
  freeTier: boolean;
  /** A server the person runs themselves. */
  local: boolean;
  /** Where to get a key (or download the server). */
  signup?: string;
  docs?: string;
  /** One line shown under the form: caveats, like short-lived tokens. */
  note?: string;
}

export const AZURE_RESOURCE: CatalogField = {
  key: 'resource',
  label: 'Resource name',
  placeholder: 'my-resource',
};
export const REGION = (fallback: string): CatalogField => ({
  key: 'region',
  label: 'Region',
  placeholder: fallback,
  default: fallback,
});

type Extra = Partial<Omit<CatalogEntry, 'id' | 'name' | 'baseUrl'>>;

export function hosted(
  id: string,
  name: string,
  baseUrl: string,
  keyEnv: string,
  signup: string,
  extra: Extra = {},
): CatalogEntry {
  return {
    id,
    name,
    baseUrl,
    fields: [],
    auth: 'bearer',
    keyEnvs: [keyEnv],
    flavor: 'openai-chat',
    modelsPath: 'models',
    freeTier: false,
    local: false,
    signup,
    ...extra,
  };
}

export function local(id: string, name: string, baseUrl: string, docs: string): CatalogEntry {
  return {
    id,
    name,
    baseUrl,
    fields: [],
    auth: 'none',
    keyEnvs: [],
    flavor: 'openai-chat',
    modelsPath: 'models',
    freeTier: true,
    local: true,
    docs,
  };
}
