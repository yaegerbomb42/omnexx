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

/**
 * Consecutive entries of these kinds fold into a single Block. Actions stay one per
 * block so a new tool call appends a node instead of rewriting the whole cluster.
 */
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

/** A fast, deterministic signature to detect whether a Block needs DOM reconciliation. */
export function blockSignature(b: Block, isActiveTail: boolean): string {
  const lastLine = b.lines.at(-1) ?? '';
  return `${b.id}:${b.kind}:${b.lines.length}:${lastLine.length}:${isActiveTail ? 1 : 0}`;
}

/** Cap mounted conversation DOM so multi-thousand-turn histories cannot grow without bound. */
export const MAX_MOUNTED_BLOCKS = 400;

export function mountedRange(
  length: number,
  max = MAX_MOUNTED_BLOCKS,
): { start: number; hidden: number } {
  const start = Math.max(0, length - max);
  return { start, hidden: start };
}

/** A relative or absolute file path worth making clickable: has a slash or a dot extension. */
const PATH = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/;

export function looksLikePath(text: string): boolean {
  return PATH.test(text) && !/^\d+(\.\d+)+$/.test(text) && !text.includes('://');
}

/** `[label](https://…)` links in already-escaped text; anything that isn't http(s) stays text. */
function linkify(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('[', at);
    const mid = open < 0 ? -1 : text.indexOf('](', open + 1);
    const close = mid < 0 ? -1 : text.indexOf(')', mid + 2);
    if (close < 0) return out + text.slice(at);
    const label = text.slice(open + 1, mid);
    const url = text.slice(mid + 2, close);
    const ok =
      label.length > 0 &&
      !label.includes('[') &&
      (url.startsWith('https://') || url.startsWith('http://')) &&
      !/\s/.test(url);
    out +=
      text.slice(at, open) + (ok ? `<a href="${url}">${label}</a>` : text.slice(open, close + 1));
    at = close + 1;
  }
}

function codeSpan(code: string): string {
  const esc = escapeHtml(code);
  return looksLikePath(code)
    ? `<code class="path" data-open="${esc}" role="link" tabindex="0">${esc}</code>`
    : `<code>${esc}</code>`;
}

function inline(text: string): string {
  // Code spans first, so their contents are left alone by the rules after them.
  return text
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`'))
        return codeSpan(part.slice(1, -1));
      return linkify(
        escapeHtml(part)
          .replaceAll(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replaceAll(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>'),
      );
    })
    .join('');
}

interface Parsed {
  html: string;
  /** The first line after the block. */
  next: number;
}

const MAX_HEADING = 4;

function isFence(line: string): boolean {
  return line.trimStart().startsWith('```');
}

function isQuote(line: string): boolean {
  return line.trimStart().startsWith('>');
}

function headingOf(line: string): { level: number; text: string } | undefined {
  const t = line.trimStart();
  let level = 0;
  while (t[level] === '#') level++;
  if (level < 1 || level > MAX_HEADING || t[level] !== ' ') return undefined;
  return { level, text: t.slice(level).trim() };
}

function listItemOf(line: string): { ordered: boolean; text: string } | undefined {
  const t = line.trimStart();
  if (/^[-*+] /.test(t)) return { ordered: false, text: t.slice(2).trim() };
  const n = /^\d{1,9}[.)] /.exec(t);
  return n ? { ordered: true, text: t.slice(n[0].length).trim() } : undefined;
}

function startsBlock(line: string): boolean {
  return (
    isFence(line) ||
    isQuote(line) ||
    headingOf(line) !== undefined ||
    listItemOf(line) !== undefined
  );
}

/** Renders unified diff lines with semantic line classes for instant visual scanning. */
function renderDiffLines(lines: readonly string[]): string {
  return lines
    .map((raw) => {
      const esc = escapeHtml(raw);
      if (raw.startsWith('+++') || raw.startsWith('---'))
        return `<span class="diff-line diff-meta">${esc}</span>`;
      if (raw.startsWith('@@')) return `<span class="diff-line diff-hunk">${esc}</span>`;
      if (raw.startsWith('+')) return `<span class="diff-line diff-add">${esc}</span>`;
      if (raw.startsWith('-')) return `<span class="diff-line diff-del">${esc}</span>`;
      return `<span class="diff-line">${esc}</span>`;
    })
    .join('\n');
}

function fenceBlock(lines: readonly string[], start: number): Parsed {
  const lang = (lines[start] ?? '').trimStart().slice(3).trim().toLowerCase();
  let i = start + 1;
  const body: string[] = [];
  while (i < lines.length && !isFence(lines[i] ?? '')) body.push(lines[i++] ?? '');
  const validLang = /^[\w+-]{1,20}$/.test(lang) ? lang : '';
  const attr = validLang ? ` data-lang="${validLang}"` : '';
  if (validLang === 'diff' || validLang === 'patch') {
    return {
      html: `<pre${attr}><code>${renderDiffLines(body)}</code></pre>`,
      next: i + 1,
    };
  }
  // Long blocks get a line-number gutter (one numbered row per line) so the
  // reader can point at a line; short blocks keep the plain single-node shape.
  // A trailing empty line from the closing fence is not a real line.
  const numbered = [...body];
  if (numbered.at(-1) === '') numbered.pop();
  if (numbered.length > 5) {
    const rows = numbered
      .map(
        (line, n) =>
          `<span class="code-line"><span class="code-ln" aria-hidden="true">${String(n + 1)}</span><span>${escapeHtml(line)}</span></span>`,
      )
      .join('\n');
    return { html: `<pre${attr}><code>${rows}</code></pre>`, next: i + 1 };
  }
  return {
    html: `<pre${attr}><code>${escapeHtml(body.join('\n'))}</code></pre>`,
    next: i + 1,
  };
}

function listBlock(lines: readonly string[], start: number, ordered: boolean): Parsed {
  let i = start;
  const items: string[] = [];
  for (let item = listItemOf(lines[i] ?? ''); item; item = listItemOf(lines[i] ?? '')) {
    items.push(`<li>${inline(item.text)}</li>`);
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

function quoteBlock(lines: readonly string[], start: number): Parsed {
  let i = start;
  const quoted: string[] = [];
  while (i < lines.length && isQuote(lines[i] ?? ''))
    quoted.push((lines[i++] ?? '').trimStart().slice(1).trim());
  return { html: `<blockquote>${inline(quoted.join(' '))}</blockquote>`, next: i };
}

function paragraph(lines: readonly string[], start: number): Parsed {
  let i = start;
  const para: string[] = [];
  while (i < lines.length && (lines[i] ?? '').trim() && !startsBlock(lines[i] ?? ''))
    para.push(lines[i++] ?? '');
  return { html: `<p>${inline(para.join(' '))}</p>`, next: i };
}

function block(lines: readonly string[], i: number): Parsed {
  const line = lines[i] ?? '';
  if (isFence(line)) return fenceBlock(lines, i);
  const heading = headingOf(line);
  if (heading) {
    const level = Math.min(6, heading.level + 2);
    return { html: `<h${String(level)}>${inline(heading.text)}</h${String(level)}>`, next: i + 1 };
  }
  const item = listItemOf(line);
  if (item) return listBlock(lines, i, item.ordered);
  if (isQuote(line)) return quoteBlock(lines, i);
  return paragraph(lines, i);
}

/** A small, safe Markdown subset: fences, headings, lists, quotes, paragraphs, inline marks. */
export function renderMarkdown(source: string): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i] ?? '').trim()) {
      i++;
      continue;
    }
    const parsed = block(lines, i);
    html.push(parsed.html);
    i = parsed.next;
  }
  return html.join('');
}

/**
 * Extracts inline `<think>...</think>` blocks (including unclosed streaming `<think>` prefixes)
 * so reasoning models streaming raw tags render inside the glassmorphic thinking accordion.
 */
export interface SplitThinkResult {
  thoughts: string[];
  isThinkingOpen: boolean;
  reply: string;
}

export function splitThinkContent(raw: string): SplitThinkResult {
  const thoughts: string[] = [];
  let isThinkingOpen = false;
  let remaining = raw;

  const closedRe = /<think>([\s\S]*?)<\/think>/gi;
  remaining = remaining.replace(closedRe, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) thoughts.push(trimmed);
    return '';
  });

  const openIdx = remaining.toLowerCase().indexOf('<think>');
  if (openIdx >= 0) {
    isThinkingOpen = true;
    const activeThought = remaining.slice(openIdx + 7).trim();
    if (activeThought) thoughts.push(activeThought);
    remaining = remaining.slice(0, openIdx);
  }

  return {
    thoughts,
    isThinkingOpen,
    reply: remaining.trim(),
  };
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
  const t = q.trimEnd();
  return (t.toLowerCase().endsWith('[y/n]') ? t.slice(0, -5) : t).trim();
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

export type ToolKind = 'run' | 'read' | 'edit' | 'diff' | 'test' | 'search' | 'mcp' | 'tool';

const TOOL_VERBS: readonly [RegExp, ToolKind][] = [
  [/^(testing|running tests|verifying|vitest|jest|pytest|cargo test|mocha)\b/i, 'test'],
  [/^running\b/i, 'run'],
  [/^(executing|bash|sh|zsh|spawn)\b/i, 'run'],
  [/^(reading|skimming|listing|viewing|cat|head|tail)\b/i, 'read'],
  [/^(diffing|patching|comparing)\b/i, 'diff'],
  [/^(editing|writing code)\b/i, 'edit'],
  [/^(looking|searching|recalling|grepping|finding|globbing)\b/i, 'search'],
  [/^(mcp|calling tool|invoking|delegating)\b/i, 'mcp'],
];

const TOOL_BADGE_LABELS: Record<ToolKind, string> = {
  run: 'BASH',
  read: 'READ',
  edit: 'EDIT',
  diff: 'DIFF',
  test: 'TEST',
  search: 'FIND',
  mcp: 'MCP',
  tool: 'TOOL',
};

/** Which icon/category a narrated tool line gets, from its leading verb or content. */
export function toolKind(line: string): ToolKind {
  const text = line.trimStart();
  const matched = TOOL_VERBS.find(([re]) => re.test(text))?.[1];
  if (matched) return matched;
  if (/[+-]\d+\s+[+-]\d+/.test(text)) return 'diff';
  return 'tool';
}

export function toolBadgeLabel(kind: ToolKind): string {
  return TOOL_BADGE_LABELS[kind];
}

/**
 * Formats a narrated tool line as rich HTML:
 * - Clickable file paths (`data-open`)
 * - Inline shell commands wrapped in `.tool-cmd`
 * - Diff stat counters (`+24` / `-9`) wrapped in `.diff-stat` pills
 * - Test pass/fail badges (`PASS` / `FAIL`)
 */
export function toolLineHtml(line: string): string {
  return line
    .trim()
    .split(/(\s+)/)
    .map((word) => {
      const path = word.replace(/^[`'"(]+|[`'",;:.)]+$/g, '');
      if (!path || !looksLikePath(path)) return escapeHtml(word);
      const at = word.indexOf(path);
      const esc = escapeHtml(path);
      return `${escapeHtml(word.slice(0, at))}<span class="path" data-open="${esc}" role="link" tabindex="0">${esc}</span>${escapeHtml(word.slice(at + path.length))}`;
    })
    .join('');
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

/**
 * The wait for a model reply: "est. 5s" counting down from the usual response time, then
 * "taking longer… 7s" counting up past it; "12s" when there is no history yet.
 */
export function etaText(
  waiting: { startedAt: number; estimateMs: number | null } | null | undefined,
  now: number,
): string {
  if (!waiting) return '';
  const elapsed = Math.max(0, now - waiting.startedAt);
  if (waiting.estimateMs === null) return `${String(Math.round(elapsed / 1000))}s`;
  const left = Math.ceil((waiting.estimateMs - elapsed) / 1000);
  if (left > 0) return `est. ${String(left)}s`;
  return `taking longer… ${String(Math.round((elapsed - waiting.estimateMs) / 1000))}s`;
}

/**
 * The run estimate under the working line ("est. ~3 min, ~40k tokens, ~$0.02", then "~2 min
 * left"), in the countdown's own style; nothing without one.
 */
export function estimateHtml(estimate: string | null | undefined): string {
  if (!estimate) return '';
  return `<div class="working"><span class="eta">${escapeHtml(estimate)}</span></div>`;
}
