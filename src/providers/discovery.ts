/** Model discovery over OpenAI `/models` and Ollama `/api/tags`. Fail soft, 5 s timeout. */

export interface DiscoveredModel {
  id: string;
  contextLength: number | undefined;
  ownedBy: string | undefined;
}

export interface DiscoveryOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface OpenAIModelList {
  data?: { id?: unknown; context_length?: unknown; owned_by?: unknown }[];
}

interface OllamaTags {
  models?: { name?: unknown }[];
}

export function normalizeContext(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

async function getJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.any(signals) });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * List models on an OpenAI-compatible endpoint (GET {base_url}/models) or an
 * Ollama server (GET /api/tags). Never throws: timeouts, non-JSON and HTTP
 * errors all yield an empty list.
 */
export async function discoverModels(
  endpoint: { baseUrl: string; apiKey?: string; kind?: 'openai' | 'ollama' },
  opts: DiscoveryOptions = {},
): Promise<DiscoveredModel[]> {
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const headers: Record<string, string> = endpoint.apiKey
    ? { authorization: `Bearer ${endpoint.apiKey}` }
    : {};
  if (endpoint.kind === 'ollama') {
    const body = (await getJson(
      fetchFn,
      `${endpoint.baseUrl.replace(/\/+$/, '')}/api/tags`,
      headers,
      timeoutMs,
    )) as OllamaTags | undefined;
    const models: { name?: unknown }[] = Array.isArray(body?.models) ? body.models : [];
    return models.flatMap((m) =>
      typeof m.name === 'string' && m.name
        ? [{ id: m.name, contextLength: undefined, ownedBy: undefined }]
        : [],
    );
  }
  const openai = (await getJson(fetchFn, modelsUrl(endpoint.baseUrl), headers, timeoutMs)) as
    OpenAIModelList | undefined;
  // Some Ollama-shaped servers answer /v1/models with `{ data: [...] }` too; accept both.
  if (openai && !Array.isArray(openai.data)) {
    const tags = (await getJson(
      fetchFn,
      `${endpoint.baseUrl.replace(/\/+$/, '')}/api/tags`,
      headers,
      timeoutMs,
    )) as OllamaTags | undefined;
    const tagsModels: { name?: unknown }[] = Array.isArray(tags?.models) ? tags.models : [];
    return tagsModels.flatMap((m) =>
      typeof m.name === 'string' && m.name
        ? [{ id: m.name, contextLength: undefined, ownedBy: undefined }]
        : [],
    );
  }
  const data: { id?: unknown; context_length?: unknown; owned_by?: unknown }[] = Array.isArray(
    openai?.data,
  )
    ? openai.data
    : [];
  return data.flatMap((m) => {
    if (typeof m.id !== 'string' || !m.id) return [];
    return [
      {
        id: m.id,
        contextLength: normalizeContext(m.context_length),
        ownedBy: typeof m.owned_by === 'string' ? m.owned_by : undefined,
      },
    ];
  });
}
