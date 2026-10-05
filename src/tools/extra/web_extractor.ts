import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

interface ParsedArticle {
  title: string | null;
  byline: string | null;
  dir: string | null;
  lang: string | null;
  content: string | null;
  textContent: string | null;
  length: number;
  excerpt: string | null;
  siteName: string | null;
  publishedTime: string | null;
}

interface ReadabilityInstance {
  parse(): ParsedArticle | null;
}

interface DOMBody {
  textContent?: string;
}

interface DOMDocument {
  body?: DOMBody;
}

/**
 * Converts HTML to clean markdown text using LinkeDOM + Readability.
 */
export function htmlToMarkdown(html: string): string {
  try {
    const parsedWindow = parseHTML(html) as unknown as { document: DOMDocument };
    const doc = parsedWindow.document;
    const ReadabilityClass = Readability as unknown as new (
      d: unknown,
      opts?: Record<string, unknown>,
    ) => ReadabilityInstance;
    const reader = new ReadabilityClass(doc, {
      charThreshold: 20,
    });
    const parsed = reader.parse();

    if (!parsed?.textContent) {
      const text = doc.body?.textContent ?? '';
      return text.trim().replace(/\n\s*\n+/g, '\n\n');
    }

    const title = parsed.title ? `# ${parsed.title}\n\n` : '';
    const byline = parsed.byline ? `*By ${parsed.byline}*\n\n` : '';
    const text = parsed.textContent
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();

    return `${title}${byline}${text}`;
  } catch {
    const clean = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
    return clean;
  }
}

/**
 * Checks if a path is disallowed by robots.txt content for User-agent: * or omnexx
 */
export function isRobotsDisallowed(robotsTxt: string, pathname: string): boolean {
  const lines = robotsTxt.split('\n');
  let appliesToAll = false;
  const disallows: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...valParts] = line.split(':');
    if (!rawKey) continue;
    const key = rawKey.trim().toLowerCase();
    const val = valParts.join(':').trim();

    if (key === 'user-agent') {
      appliesToAll = val === '*' || val === 'omnexx';
    } else if (appliesToAll && key === 'disallow') {
      if (val) disallows.push(val);
    }
  }

  for (const rule of disallows) {
    if (rule === '/') return true;
    if (pathname.startsWith(rule)) return true;
  }
  return false;
}
