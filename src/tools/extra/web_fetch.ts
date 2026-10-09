import { z } from 'zod';
import type { ToolSource } from './types.js';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import type { OmnexxConfig } from '../../config/schema.js';
import { matchesAny } from '../../security/glob.js';
import { CHARS_PER_TOKEN } from '../../core/tokens.js';
import { htmlToMarkdown, isRobotsDisallowed } from './web_extractor.js';
import type { WebConfig } from '../../config/sections/web.js';

const DEFAULT_FETCH_MAX_TOKENS = 8000;
const runCache = new Map<string, string>();
let activeWebConfig: WebConfig | undefined;

export function setWebConfig(config?: Partial<WebConfig>): void {
  activeWebConfig = config as WebConfig | undefined;
}

export function clearWebFetchCache(): void {
  runCache.clear();
}

const schema = z.strictObject({
  url: z.url().describe('The HTTP or HTTPS URL to fetch and convert to markdown'),
  maxTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum tokens to return (default: 8000)'),
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

export const webFetchTool: Tool<typeof schema> = {
  name: 'web_fetch',
  description:
    'Fetch content from a web page via HTTP GET, convert HTML to clean markdown text, and return up to maxTokens. Honours robots.txt, respects host allow/deny config, and caches per run.',
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

    const cached = runCache.get(rawUrl);
    if (cached !== undefined) {
      return ok(cached);
    }

    const timeoutMs = 15_000;
    const maxBytes = activeWebConfig?.max_fetch_bytes ?? 5 * 1024 * 1024; // 5 MB cap

    // Check robots.txt
    try {
      const robotsUrl = `${parsedUrl.origin}/robots.txt`;
      const robotsController = new AbortController();
      const rTimeout = setTimeout(() => {
        robotsController.abort();
      }, 5_000);
      const robotsRes = await fetch(robotsUrl, {
        signal: robotsController.signal,
        headers: { 'User-Agent': 'omnexx' },
      }).catch(() => null);
      clearTimeout(rTimeout);

      if (robotsRes?.ok) {
        const robotsText = await robotsRes.text();
        if (isRobotsDisallowed(robotsText, parsedUrl.pathname)) {
          return fail(
            `Access to "${parsedUrl.pathname}" is disallowed by robots.txt on ${parsedUrl.hostname}`,
          );
        }
      }
    } catch {
      // If fetching robots.txt errors out, continue with standard fetch
    }

    // Fetch the actual page
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetch(rawUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'omnexx (compatible; bot)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      });

      if (!res.ok) {
        return fail(`HTTP error: ${res.status} ${res.statusText}`);
      }

      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxBytes) {
        return fail(`Content length (${contentLength} bytes) exceeds maximum limit of 5 MB`);
      }

      const text = await res.text();
      if (text.length > maxBytes) {
        return fail(`Response body size (${text.length} bytes) exceeds maximum limit of 5 MB`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      let markdown: string;
      if (
        contentType.includes('text/html') ||
        text.includes('<html') ||
        text.includes('<!DOCTYPE')
      ) {
        markdown = htmlToMarkdown(text);
      } else {
        markdown = text;
      }

      const maxTokens = input.maxTokens ?? DEFAULT_FETCH_MAX_TOKENS;
      const maxChars = maxTokens * CHARS_PER_TOKEN;
      if (markdown.length > maxChars) {
        markdown = markdown.slice(0, maxChars) + '\n\n… [Content truncated to token cap]';
      }

      const redacted = ctx.redactor.text(markdown);
      runCache.set(rawUrl, redacted);
      return ok(redacted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Failed to fetch ${rawUrl}: ${ctx.redactor.text(msg)}`);
    } finally {
      clearTimeout(timer);
    }
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
