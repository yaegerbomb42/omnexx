import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { nodeToMarkdown, type MdNode } from './web_markdown.js';

interface ParsedArticle {
  title: string | null;
  byline: string | null;
  content: string | null;
}

interface ReadabilityInstance {
  parse(): ParsedArticle | null;
}

interface DOMElement {
  remove(): void;
  getAttribute(name: string): string | null;
}

interface DOMDocument {
  body: (MdNode & { innerHTML: string }) | null;
  querySelectorAll(selector: string): ArrayLike<DOMElement>;
}

/** Page chrome that is never the content the agent asked for. */
const NOISE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  'nav',
  'footer',
  'aside',
  'form',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '[hidden]',
].join(',');
/** Class or id words of ads, cookie banners and the like. */
const NOISE_NAME =
  /(^|[\s_-])(ads?|advert\w*|banner|cookies?|consent|promo|sponsor\w*|sidebar|newsletter|share|social|popup|modal)([\s_-]|$)/i;

const EMPTY: MdNode = { nodeType: 3, nodeName: '#text', textContent: '', childNodes: [] };

function parse(html: string): DOMDocument {
  return (parseHTML(html) as unknown as { document: DOMDocument }).document;
}

function stripNoise(doc: DOMDocument): void {
  for (const el of Array.from(doc.querySelectorAll(NOISE_SELECTOR))) el.remove();
  for (const el of Array.from(doc.querySelectorAll('[class],[id]'))) {
    const name = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
    if (NOISE_NAME.test(name)) el.remove();
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function readArticle(doc: DOMDocument, title: string): ParsedArticle | null {
  const ReadabilityClass = Readability as unknown as new (
    d: unknown,
    opts?: Record<string, unknown>,
  ) => ReadabilityInstance;
  // Readability edits the document it reads, so it gets its own copy.
  const copy = parse(
    `<html><head><title>${title}</title></head><body>${doc.body?.innerHTML ?? ''}</body></html>`,
  );
  return new ReadabilityClass(copy, { charThreshold: 20 }).parse();
}

/**
 * Converts a page to compact markdown: drops scripts, styles, navigation, ads and cookie
 * banners, extracts the main content with Readability, and keeps headings, lists, code, links
 * and tables. Falls back to the whole cleaned body when no article is found.
 */
export function htmlToMarkdown(html: string): string {
  try {
    const doc = parse(html);
    const pageTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
    stripNoise(doc);
    const article = readArticle(doc, pageTitle);
    const content = article?.content ? parse(`<html><body>${article.content}</body></html>`) : doc;
    const text = nodeToMarkdown(content.body ?? EMPTY);
    const title = (article?.title ?? pageTitle).trim();
    const byline = article?.byline?.trim().replace(/^by\s+/i, '');
    // The title is often the article's own first heading as well.
    const head = [
      title && !text.startsWith(`# ${title}`) ? `# ${title}` : '',
      byline ? `*By ${byline}*` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return head ? `${head}\n\n${text}` : text;
  } catch {
    return stripTags(html);
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
