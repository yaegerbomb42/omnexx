import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToMarkdown } from '../../../src/tools/extra/web_extractor.js';
import { estimateTokens } from '../../../src/core/tokens.js';

const SITES = join(dirname(fileURLToPath(import.meta.url)), '../../../bench/suites/web5');
const page = (rel: string): string => readFileSync(join(SITES, rel), 'utf-8');

/** A docs page as real sites ship it: the content is a small part of the bytes. */
const NOISY_DOCS = `<!doctype html><html><head><title>Widget API</title>
<style>${'.x{color:red}'.repeat(400)}</style>
<script>${'window.track&&track("view");'.repeat(300)}</script>
<script type="application/ld+json">{"@context":"https://schema.org"}</script></head>
<body>
<header><nav>${Array.from({ length: 60 }, (_, i) => `<a href="/section-${i}">Section ${i}</a>`).join(' ')}</nav></header>
<div class="cookie-banner">We value your privacy. <button>Accept all</button></div>
<div id="sidebar"><ul>${Array.from({ length: 40 }, (_, i) => `<li><a href="/p${i}">Page ${i}</a></li>`).join('')}</ul></div>
<main><article>
<h1>Widget API</h1>
<p>Call <code>widget.mount(el, { theme })</code> to render. It returns a <strong>handle</strong>.</p>
<h2>Options</h2>
<table><tr><th>Name</th><th>Default</th></tr><tr><td>theme</td><td>"light"</td></tr></table>
<pre><code>const h = widget.mount(document.body, { theme: 'dark' });
  h.destroy();</code></pre>
<ul><li>Mounting twice throws.</li><li>See <a href="/guide">the guide</a>.</li></ul>
</article></main>
<div class="ad-slot">BUY NOW</div>
<footer>${'<p>Legal text and links.</p>'.repeat(30)}</footer>
</body></html>`;

describe('htmlToMarkdown', () => {
  it('keeps the article as markdown: headings, code, tables, lists, links', () => {
    const md = htmlToMarkdown(NOISY_DOCS);
    expect(md).toContain('# Widget API');
    expect(md).toContain('## Options');
    expect(md).toContain('`widget.mount(el, { theme })`');
    expect(md).toContain('**handle**');
    expect(md).toContain('| theme | "light" |');
    expect(md).toContain(
      "```\nconst h = widget.mount(document.body, { theme: 'dark' });\n  h.destroy();\n```",
    );
    expect(md).toContain('- Mounting twice throws.');
    expect(md).toContain('[the guide](/guide)');
  });

  it('drops scripts, styles, navigation, cookie banners, sidebars, ads and footers', () => {
    const md = htmlToMarkdown(NOISY_DOCS);
    for (const noise of [
      'track(',
      'color:red',
      'Section 12',
      'Accept all',
      'Page 7',
      'BUY NOW',
      'Legal text',
    ])
      expect(md).not.toContain(noise);
  });

  it('costs a small fraction of the raw HTML in tokens', () => {
    const raw = estimateTokens(NOISY_DOCS);
    const md = estimateTokens(htmlToMarkdown(NOISY_DOCS));
    expect(md / raw).toBeLessThan(0.1);
  });

  it('saves tokens on the web5 docs pages too, and keeps the facts tasks need', () => {
    const rates = page('task-03-rate-card-lookup/site/carriers/rates.html');
    const md = htmlToMarkdown(rates);
    expect(md).toContain('| C | 7.75 | 1.60 |');
    expect(md).toContain('remote-area surcharge of 2.50');
    expect(md).not.toContain('1-800-PARCELS');
    expect(estimateTokens(md)).toBeLessThan(estimateTokens(rates) * 0.6);

    const guide = htmlToMarkdown(page('task-04-migrate-datekit/site/migrate-v2.html'));
    expect(guide).toContain('`DateKit.from(str, { pattern })`');
    expect(guide).not.toContain('We use cookies');
  });

  it('falls back to the body text of a page with no article', () => {
    expect(htmlToMarkdown('<html><body><p>ok</p></body></html>')).toContain('ok');
    expect(htmlToMarkdown('plain words')).toContain('plain words');
  });
});
