import { z } from 'zod';
import type { ToolSource } from './types.js';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import type { OmnexxConfig } from '../../config/schema.js';
import type { SearchBackend, WebConfig } from '../../config/sections/web.js';
import { parseDuration } from '../../config/duration.js';
import { fetchWithRetry } from './web_http.js';
import { privateTarget } from './private-address.js';

const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
/** Queries remembered per run; the oldest go first. */
const MAX_CACHED_QUERIES = 50;
/** Snippets are hints, not content: web_fetch reads the page. */
const MAX_SNIPPET_CHARS = 300;

let activeWebConfig: WebConfig | undefined;
/** Formatted results per run, backend, query and count. One run never serves another. */
const searchCache = new Map<string, string>();

export function setWebSearchConfig(config?: Partial<WebConfig>): void {
  activeWebConfig = config as WebConfig | undefined;
}

export function clearWebSearchCache(): void {
  searchCache.clear();
}

function searchTimeoutMs(): number {
  try {
    return parseDuration(activeWebConfig?.search_timeout ?? '15s');
  } catch {
    return DEFAULT_SEARCH_TIMEOUT_MS;
  }
}

/** Search APIs get a timeout per attempt and retries on 429/5xx/network errors. */
function searchFetch(url: string, init: RequestInit): Promise<Response> {
  return fetchWithRetry(url, init, { timeoutMs: searchTimeoutMs() });
}

const clipSnippet = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SNIPPET_CHARS ? `${flat.slice(0, MAX_SNIPPET_CHARS)}…` : flat;
};

const schema = z.strictObject({
  query: z.string().describe('Search query string'),
  n: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of results to return (default: 5)'),
});

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const res = await searchFetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`Brave search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  const results: SearchResultItem[] = [];
  for (const item of data.web?.results ?? []) {
    if (item.title && item.url) {
      results.push({
        title: item.title,
        url: item.url,
        snippet: item.description ?? '',
      });
    }
  }
  return results;
}

async function searchTavily(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const res = await searchFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: count,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of data.results ?? []) {
    if (item.title && item.url) {
      results.push({
        title: item.title,
        url: item.url,
        snippet: item.content ?? '',
      });
    }
  }
  return results;
}

async function searchExa(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const res = await searchFetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: count,
    }),
  });

  if (!res.ok) {
    throw new Error(`Exa search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; text?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of data.results ?? []) {
    if (item.title && item.url) {
      results.push({
        title: item.title,
        url: item.url,
        snippet: item.text ?? '',
      });
    }
  }
  return results;
}

async function searchSearxng(
  query: string,
  count: number,
  baseUrl: string,
): Promise<SearchResultItem[]> {
  const url = new URL(baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const res = await searchFetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`SearXNG search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of (data.results ?? []).slice(0, count)) {
    if (item.title && item.url) {
      results.push({
        title: item.title,
        url: item.url,
        snippet: item.content ?? '',
      });
    }
  }
  return results;
}

export function resolveSearchKey(backend: SearchBackend, keyEnv?: string): string | undefined {
  if (keyEnv) {
    return process.env[keyEnv];
  }
  switch (backend) {
    case 'brave':
      return process.env.BRAVE_API_KEY ?? process.env.BRAVE_SEARCH_API_KEY;
    case 'tavily':
      return process.env.TAVILY_API_KEY;
    case 'exa':
      return process.env.EXA_API_KEY;
    case 'searxng':
      return undefined;
  }
}

export const webSearchTool: Tool<typeof schema> = {
  name: 'web_search',
  description:
    'Search the web (configured backend). Returns titles, URLs and short snippets; read a result with web_fetch. Cached per run.',
  schema,
  readOnly: true,
  async run(input, ctx: ToolContext): Promise<ToolOutput> {
    const backend = activeWebConfig?.search;
    if (!backend) {
      return fail('No web search backend configured in [web] search.');
    }

    const count = input.n ?? 5;
    const key = resolveSearchKey(backend, activeWebConfig?.search_key_env);

    const cacheKey = `${ctx.store.runId}\n${backend}\n${count}\n${input.query}`;
    const cached = searchCache.get(cacheKey);
    if (cached !== undefined) return ok(cached);

    try {
      let items: SearchResultItem[] = [];
      switch (backend) {
        case 'brave':
          if (!key)
            return fail(
              'Missing API key for Brave search (set BRAVE_API_KEY or [web] search_key_env)',
            );
          items = await searchBrave(input.query, count, key);
          break;
        case 'tavily':
          if (!key)
            return fail(
              'Missing API key for Tavily search (set TAVILY_API_KEY or [web] search_key_env)',
            );
          items = await searchTavily(input.query, count, key);
          break;
        case 'exa':
          if (!key)
            return fail('Missing API key for Exa search (set EXA_API_KEY or [web] search_key_env)');
          items = await searchExa(input.query, count, key);
          break;
        case 'searxng': {
          const searxUrl = activeWebConfig?.search_url ?? process.env.SEARXNG_URL;
          if (!searxUrl)
            return fail('Missing SearXNG instance URL (set SEARXNG_URL or [web] search_url)');
          const parsed = new URL(searxUrl);
          const allowList = activeWebConfig?.allow ?? ['*'];
          const named = allowList.filter((a) => a !== '*');
          if (!(
            named.length &&
            named.some((a) => parsed.hostname === a || parsed.hostname.endsWith('.' + a))
          )) {
            try {
              const why = await privateTarget(parsed.hostname);
              if (why) return fail(`SearXNG URL refused: ${why}`);
            } catch {
              return fail('Invalid SearXNG URL');
            }
          }
          items = await searchSearxng(input.query, count, searxUrl);
          break;
        }
      }

      if (items.length === 0) {
        return ok(`No search results found for: ${input.query}`);
      }

      const formatted = ctx.redactor.text(
        items
          .slice(0, count)
          .map(
            (item, idx) =>
              `${idx + 1}. [${item.title}](${item.url})\n   ${clipSnippet(item.snippet)}`,
          )
          .join('\n\n'),
      );
      searchCache.set(cacheKey, formatted);
      const oldest = searchCache.keys().next().value;
      if (searchCache.size > MAX_CACHED_QUERIES && oldest !== undefined) searchCache.delete(oldest);
      return ok(formatted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Search failed: ${ctx.redactor.text(msg)}`);
    }
  },
};

export const source: ToolSource = {
  load(config: OmnexxConfig): readonly Tool[] {
    setWebSearchConfig(config.web);
    if (!config.web.search) {
      return [];
    }
    return [webSearchTool];
  },
};
