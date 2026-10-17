import { z } from 'zod';
import type { ToolSource } from './types.js';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import type { OmnexxConfig } from '../../config/schema.js';
import { parseDuration } from '../../config/duration.js';
import { matchesAny } from '../../security/glob.js';
import { CHARS_PER_TOKEN } from '../../core/tokens.js';
import { htmlToMarkdown, isRobotsDisallowed } from './web_extractor.js';
import { fetchWithRetry, readCapped } from './web_http.js';
import type { WebConfig } from '../../config/sections/web.js';

/** Tokens per page of output; longer pages continue with `page: 2`, and so on. */
const DEFAULT_PAGE_TOKENS = 6000;
const DEFAULT_TIMEOUT_MS = 15_000;
const ROBOTS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Pages kept per run; the oldest go first. */
const MAX_CACHED_PAGES = 50;
/** A page break may land this far before the cap to end on a paragraph. */
const BREAK_SLACK = 0.3;

/** Converted (and redacted) text per URL for this run: later pages never refetch. */
const runCache = new Map<string, string>();
let activeWebConfig: WebConfig | undefined;

export function setWebConfig(config?: Partial<WebConfig>): void {
  activeWebConfig = config as WebConfig | undefined;
}

export function clearWebFetchCache(): void {
  runCache.clear();
}

const schema = z.strictObject({
  url: z.url().describe('http(s) URL'),
  page: z.number().int().positive().optional().describe('Page of a long result (default 1)'),
  maxTokens: z.number().int().positive().optional().describe('Tokens per page (default 6000)'),
});

function isHostAllowed(
  hostname: string,
  allowList: readonly string[],
  denyList: readonly string[],
): boolean {
  if (denyList.length > 0 && matchesAny(hostname, denyList)) {
    return false;
  }
  if (allowList.length === 0 || allowList.includes('*')) {
    return true;
  }
  return Boolean(matchesAny(hostname, allowList));
}

/** Splits text into pages of at most `maxChars`, preferring paragraph then line breaks. */
export function paginate(text: string, maxChars: number): string[] {
  const pages: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const floor = Math.floor(maxChars * (1 - BREAK_SLACK));
    const para = window.lastIndexOf('\n\n');
    const line = window.lastIndexOf('\n');
    const cut = para >= floor ? para : line >= floor ? line : maxChars;
    pages.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return [...pages, rest];
}

/** One run's cache never serves another run: a later run must see the current page. */
function cacheKey(runId: string, url: string): string {
  return `${runId}\n${url}`;
}

function remember(key: string, text: string): void {
  runCache.set(key, text);
  const oldest = runCache.keys().next().value;
  if (runCache.size > MAX_CACHED_PAGES && oldest !== undefined) runCache.delete(oldest);
}

function timeoutMs(): number {
  try {
    return parseDuration(activeWebConfig?.fetch_timeout ?? '15s');
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}

async function robotsAllows(url: URL): Promise<boolean> {
  try {
    const res = await fetchWithRetry(
      `${url.origin}/robots.txt`,
      { headers: { 'User-Agent': 'omnexx' } },
      { timeoutMs: ROBOTS_TIMEOUT_MS, retries: 0 },
    );
    if (!res.ok) return true;
    return !isRobotsDisallowed(await res.text(), url.pathname);
  } catch {
    // No robots.txt reachable: nothing forbids the fetch.
    return true;
  }
}

const isHtml = (contentType: string, text: string): boolean =>
  contentType.includes('html') || /<html|<!doctype html/i.test(text.slice(0, 2000));

/** Fetches and converts the page; a string is the text, a ToolOutput a failure to report. */
async function load(url: URL, ctx: ToolContext): Promise<string | ToolOutput> {
  const maxBytes = activeWebConfig?.max_fetch_bytes ?? DEFAULT_MAX_BYTES;
  const capMb = Math.round(maxBytes / (1024 * 1024));
  const res = await fetchWithRetry(
    url.href,
    {
      headers: {
        'User-Agent': 'omnexx (compatible; bot)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    },
    { timeoutMs: timeoutMs() },
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return fail(`HTTP error: ${res.status} ${res.statusText}`);
  }
  const contentLength = Number(res.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return fail(
      `Content length (${contentLength} bytes) exceeds maximum limit of ${capMb} MB; find a smaller page or a raw/text version`,
    );
  }
  const body = await readCapped(res, maxBytes);
  const text = isHtml(res.headers.get('content-type') ?? '', body.text)
    ? htmlToMarkdown(body.text)
    : body.text;
  const note = body.truncated ? `\n\n[download stopped at the ${capMb} MB cap]` : '';
  return ctx.redactor.text(text + note);
}

export const webFetchTool: Tool<typeof schema> = {
  name: 'web_fetch',
  description:
    'GET a web page as clean markdown (main content only; nav, ads and scripts removed). Long pages are split: pass page: N to continue. Cached per run.',
  schema,
  readOnly: true,
  async run(input, ctx: ToolContext): Promise<ToolOutput> {
    const rawUrl = input.url;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return fail(`Invalid URL: ${rawUrl}`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return fail(
        `Unsupported protocol: ${parsedUrl.protocol}. Only http and https are supported.`,
      );
    }

    const allowList = activeWebConfig?.allow ?? ['*'];
    const denyList = activeWebConfig?.deny ?? [];

    if (!isHostAllowed(parsedUrl.hostname, allowList, denyList)) {
      return fail(`Host "${parsedUrl.hostname}" is not allowed by policy.`);
    }

    const key = cacheKey(ctx.store.runId, rawUrl);
    let text = runCache.get(key);
    if (text === undefined) {
      if (!(await robotsAllows(parsedUrl))) {
        return fail(
          `Access to "${parsedUrl.pathname}" is disallowed by robots.txt on ${parsedUrl.hostname}`,
        );
      }
      try {
        const loaded = await load(parsedUrl, ctx);
        if (typeof loaded !== 'string') return loaded;
        text = loaded;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`Failed to fetch ${rawUrl}: ${ctx.redactor.text(msg)}`);
      }
      remember(key, text);
    }

    const pageTokens = input.maxTokens ?? DEFAULT_PAGE_TOKENS;
    const pages = paginate(text, pageTokens * CHARS_PER_TOKEN);
    const page = input.page ?? 1;
    if (page > pages.length) {
      return fail(`page ${page} does not exist: ${rawUrl} has ${pages.length} page(s)`);
    }
    if (pages.length === 1) return ok(pages[0] ?? '');
    const more =
      page < pages.length
        ? `call web_fetch again with page: ${page + 1} for more`
        : 'end of document';
    return ok(`${pages[page - 1] ?? ''}\n\n[page ${page} of ${pages.length}; ${more}]`);
  },
};

export const source: ToolSource = {
  load(config: OmnexxConfig): readonly Tool[] {
    setWebConfig(config.web);
    if (!config.web.fetch_enabled) {
      return [];
    }
    return [webFetchTool];
  },
};
