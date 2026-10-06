import { z } from 'zod';
import type { ToolSource } from './types.js';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import type { OmnexxConfig } from '../../config/schema.js';
import type { SearchBackend, WebConfig } from '../../config/sections/web.js';

let activeWebConfig: WebConfig | undefined;

export function setWebSearchConfig(config?: Partial<WebConfig>): void {
  activeWebConfig = config as WebConfig | undefined;
}

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

  const res = await fetch(url.toString(), {
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
  const res = await fetch('https://api.tavily.com/search', {
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
  const res = await fetch('https://api.exa.ai/search', {
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

  const res = await fetch(url.toString(), {
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
    'Search the web using configured search backend (brave, tavily, searxng, exa). Returns titles, URLs, and snippets.',
  schema,
  readOnly: true,
  async run(input, ctx: ToolContext): Promise<ToolOutput> {
    const backend = activeWebConfig?.search;
    if (!backend) {
      return fail('No web search backend configured in [web] search.');
    }

    const count = input.n ?? 5;
    const key = resolveSearchKey(backend, activeWebConfig?.search_key_env);

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
          items = await searchSearxng(input.query, count, searxUrl);
          break;
        }
      }

      if (items.length === 0) {
        return ok(`No search results found for: ${input.query}`);
      }

      const formatted = items
        .map((item, idx) => `${idx + 1}. [${item.title}](${item.url})\n   ${item.snippet}`)
        .join('\n\n');

      return ok(ctx.redactor.text(formatted));
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
