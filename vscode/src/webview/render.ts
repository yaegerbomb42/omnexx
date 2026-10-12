/**
 * Turning chat-server output into the panel's HTML. No DOM and no VS Code here, so it is
 * unit-tested from the root suite. Everything the model wrote is escaped before any markup is
 * added: a reply can never inject HTML or script into the panel.
 */

export type EntryKind = 'feed' | 'out' | 'err' | 'user' | 'system' | 'act' | 'think';

export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
}

export interface Block {
  /** The first entry's id: stable while later lines join the block. */
  id: number;
  kind: EntryKind;
  lines: string[];
}

export interface Usage {
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
  usd: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  compactions: number;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Kinds whose consecutive lines read as one message. Actions stay one line each. */
const JOINS = new Set<EntryKind>(['out', 'user', 'think', 'err', 'system', 'feed']);

/** Fold new entries into blocks: consecutive lines of a joining kind become one message. */
export function addEntries(blocks: readonly Block[], entries: readonly Entry[]): Block[] {
  const out = [...blocks];
  for (const e of entries) {
    const last = out.at(-1);
    if (last?.kind === e.kind && JOINS.has(e.kind)) {
      out[out.length - 1] = { ...last, lines: [...last.lines, e.text] };
    } else {
      out.push({ id: e.id, kind: e.kind, lines: [e.text] });
    }
  }
  return out;
}

/** A relative or absolute file path worth making clickable: has a slash or a dot extension. */
const PATH = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8}(?::\d+)?$/;

export function looksLikePath(text: string): boolean {
  return PATH.test(text) && !/^\d+(\.\d+)+$/.test(text) && !text.includes('://');
}

function inline(text: string): string {
  // Code spans first, so their contents are left alone by the rules after them.
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
        const code = part.slice(1, -1);
        const esc = escapeHtml(code);
        return looksLikePath(code)
          ? `<code class="path" data-open="${esc}" role="link" tabindex="0">${esc}</code>`
          : `<code>${esc}</code>`;
      }
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          (_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
        );
    })
    .join('');
}

/** A small, safe Markdown subset: fences, headings, lists, quotes, paragraphs, inline marks. */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = /^\s*```\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) body.push(lines[i++] ?? '');
      i++;
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : '';
      html.push(`<pre${lang}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, (heading[1]?.length ?? 1) + 2);
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+/;
    if (list.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && list.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(list, ''))}</li>`);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? ''))
        quoted.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${inline(quoted.join(' '))}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i] ?? '')
    )
      para.push(lines[i++] ?? '');
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return html.join('');
}

const UNITS: [number, string][] = [
  [1_000_000, 'M'],
  [1_000, 'k'],
];

/** 950 → "950", 12_345 → "12.3k", 2_500_000 → "2.5M". */
export function formatTokens(n: number): string {
  for (const [size, unit] of UNITS)
    if (n >= size)
      return `${(n / size).toFixed(n >= size * 100 ? 0 : 1).replace(/\.0$/, '')}${unit}`;
  return String(Math.round(n));
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** Share of input tokens served from the prompt cache, 0-100. */
export function cacheHitPercent(u: Usage): number {
  return u.tokens.input ? Math.round((u.tokens.cacheRead / u.tokens.input) * 100) : 0;
}

/** Context fill as a percentage of where the chat compacts, capped at 100. */
export function contextPercent(context: { used: number; limit: number } | null): number {
  if (!context || context.limit <= 0) return 0;
  return Math.min(100, Math.round((context.used / context.limit) * 100));
}

/** The question without its terminal-style "[y/N]" suffix. */
export function cleanQuestion(q: string): string {
  return q.replace(/\s*\[y\/N\]\s*$/i, '').trim();
}

/** 3_855_000 ms → "01:04:15". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3_600))}:${pad(Math.floor((total % 3_600) / 60))}:${pad(total % 60)}`;
}

/** 0 → "ST-01". */
export function stepLabel(index: number): string {
  return `ST-${String(index + 1).padStart(2, '0')}`;
}

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export type StepState = 'done' | 'active' | 'waiting' | 'queued';

/**
 * How each step of the todo list draws on the timeline: done, the one in progress, the next one
 * up (waiting on it), and the rest queued. With nothing in progress, the first open step is next.
 */
export function stepStates(items: readonly TodoItem[]): StepState[] {
  const active = items.findIndex((t) => t.status === 'in_progress');
  const next = items.findIndex((t, i) => t.status === 'pending' && i > active);
  return items.map((t, i) => {
    if (t.status === 'done') return 'done';
    if (t.status === 'in_progress') return 'active';
    return i === next ? 'waiting' : 'queued';
  });
}

/** Done steps as a share of all steps, 0-100. */
export function stepsPercent(items: readonly TodoItem[]): number {
  if (!items.length) return 0;
  return Math.round((items.filter((t) => t.status === 'done').length / items.length) * 100);
}

export type LogRole = 'agent' | 'think' | 'system' | 'error';

/** Which tag a line gets in the live log; user messages and replies stay in the conversation. */
export function logRole(kind: EntryKind): LogRole | undefined {
  switch (kind) {
    case 'act':
      return 'agent';
    case 'think':
      return 'think';
    case 'feed':
    case 'system':
      return 'system';
    case 'err':
      return 'error';
    default:
      return undefined;
  }
}
