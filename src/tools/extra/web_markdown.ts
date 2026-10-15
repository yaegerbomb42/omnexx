/**
 * A small DOM-to-markdown converter for fetched pages: keeps headings, paragraphs, lists, code,
 * links and tables, drops everything else down to its text. Works on linkedom nodes.
 */

export interface MdNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<MdNode>;
  getAttribute?(name: string): string | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
/** Whole subtrees that are never content. */
const SKIP = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
  'IFRAME',
  'CANVAS',
  'BUTTON',
  'SELECT',
  'INPUT',
  'TEXTAREA',
  'FORM',
]);
const BLOCK = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'NAV',
  'BLOCKQUOTE',
  'FIGURE',
  'FIGCAPTION',
  'DL',
  'DT',
  'DD',
  'TABLE',
  'UL',
  'OL',
  'HR',
]);
const MAX_LINK_CHARS = 200;

const children = (n: MdNode): MdNode[] => Array.from(n.childNodes);
const collapse = (s: string): string => s.replace(/\s+/g, ' ');

function inline(n: MdNode): string {
  return children(n).map(render).join('');
}

function link(n: MdNode): string {
  const text = collapse(inline(n)).trim();
  const href = n.getAttribute?.('href') ?? '';
  // In-page anchors, script links and very long URLs only cost tokens.
  if (!text || !href || href.startsWith('#') || /^javascript:/i.test(href)) return text;
  if (href.length > MAX_LINK_CHARS || text === href) return text;
  return `[${text}](${href})`;
}

function list(n: MdNode, ordered: boolean): string {
  let i = 0;
  const items = children(n)
    .filter((c) => c.nodeName === 'LI')
    .map((li) => {
      i++;
      const body = inline(li).trim().replace(/\n+/g, '\n  ');
      return `${ordered ? `${i}.` : '-'} ${body}`;
    });
  return `\n\n${items.join('\n')}\n\n`;
}

function table(n: MdNode): string {
  const rows: string[][] = [];
  const walk = (el: MdNode): void => {
    for (const c of children(el)) {
      if (c.nodeName === 'TR')
        rows.push(
          children(c)
            .filter((td) => td.nodeName === 'TD' || td.nodeName === 'TH')
            .map((td) => collapse(inline(td)).trim().replace(/\|/g, '\\|')),
        );
      else if (c.nodeType === ELEMENT_NODE) walk(c);
    }
  };
  walk(n);
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  const [head, ...rest] = rows;
  const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return `\n\n${[line(head ?? []), sep, ...rest.map(line)].join('\n')}\n\n`;
}

function render(n: MdNode): string {
  if (n.nodeType === TEXT_NODE) return collapse(n.textContent ?? '');
  if (n.nodeType !== ELEMENT_NODE) return '';
  const tag = n.nodeName.toUpperCase();
  if (SKIP.has(tag)) return '';
  const heading = /^H([1-6])$/.exec(tag);
  if (heading) return `\n\n${'#'.repeat(Number(heading[1]))} ${collapse(inline(n)).trim()}\n\n`;
  switch (tag) {
    case 'BR':
      return '\n';
    case 'PRE':
      return `\n\n\`\`\`\n${(n.textContent ?? '').replace(/\n+$/, '')}\n\`\`\`\n\n`;
    case 'CODE':
      return `\`${n.textContent ?? ''}\``;
    case 'A':
      return link(n);
    case 'STRONG':
    case 'B': {
      const t = inline(n).trim();
      return t ? `**${t}**` : '';
    }
    case 'EM':
    case 'I': {
      const t = inline(n).trim();
      return t ? `*${t}*` : '';
    }
    case 'IMG': {
      const alt = n.getAttribute?.('alt')?.trim();
      return alt ? `[image: ${alt}]` : '';
    }
    case 'UL':
      return list(n, false);
    case 'OL':
      return list(n, true);
    case 'TABLE':
      return table(n);
    case 'LI':
      return `\n- ${inline(n).trim()}\n`;
  }
  const body = inline(n);
  return BLOCK.has(tag) ? `\n\n${body}\n\n` : body;
}

/** Markdown for a DOM subtree, with blank-line runs and trailing spaces cleaned up. */
export function nodeToMarkdown(root: MdNode): string {
  let inFence = false;
  return render(root)
    .split('\n')
    .map((l) => {
      if (l.startsWith('```')) inFence = !inFence;
      // Code keeps its indentation; elsewhere leading space is left over from the HTML source.
      return inFence ? l.replace(/[ \t]+$/, '') : l.trim();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
