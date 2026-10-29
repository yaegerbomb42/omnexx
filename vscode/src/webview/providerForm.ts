/**
 * The catalog-driven part of the settings page's add-provider form: the values a templated base
 * URL needs (Azure resource, AWS region, GCP project), the custom endpoint's API flavor and extra
 * headers, and the inline result of the Test button (`probeProvider` → `providerProbe`).
 */
import { escapeHtml } from './render.js';

export interface CatalogField {
  key: string;
  label: string;
  placeholder: string;
  default?: string;
}

/** The catalog fields this form reads; settings.ts's CatalogProvider carries them. */
export interface FormProvider {
  name: string;
  label: string;
  baseUrl: string;
  local: boolean;
  fields?: readonly CatalogField[];
  note?: string;
  docs?: string;
}

export interface ProbeView {
  ok: boolean;
  detail: string;
  baseUrl: string;
  flavor?: string;
  models: string[];
}

export interface FormExtras {
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  flavor?: string;
}

const FLAVORS: readonly [string, string][] = [
  ['', 'Detect automatically'],
  ['openai-chat', 'OpenAI-compatible (Chat Completions)'],
  ['anthropic', 'Anthropic-compatible (Messages)'],
  ['openai-responses', 'OpenAI Responses'],
  ['gemini', 'Google Gemini'],
];
const HEADER_LINE = /^([A-Za-z0-9-]{1,64})\s*:\s*(.+)$/;

/** What the person typed in the extra inputs, kept across redraws. */
let typed: Record<string, string> = {};
let probe: 'running' | ProbeView | undefined;

export function reset(): void {
  typed = {};
  probe = undefined;
}

/** An input, textarea or select as the page's input listener sees it (no DOM types here). */
export interface ExtraInput {
  dataset?: { extra?: string | undefined };
  value?: unknown;
}

/** Remember an extra input's value (called from the page's input listener). */
export function remember(target: ExtraInput | null): void {
  const key = target?.dataset?.extra;
  if (key && typeof target.value === 'string') typed = { ...typed, [key]: target.value };
}

function input(id: string, label: string, placeholder: string, value: string): string {
  return `<label for="add-x-${escapeHtml(id)}">${escapeHtml(label)}</label><input id="add-x-${escapeHtml(id)}" data-extra="${escapeHtml(id)}" class="field" type="text" spellcheck="false" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">`;
}

/** The inputs a provider needs beyond a key, plus custom-endpoint options. */
export function extrasHtml(p: FormProvider | undefined, custom: boolean): string {
  const fields = (p?.fields ?? [])
    .map((f) => input(`f-${f.key}`, f.label, f.placeholder, typed[`f-${f.key}`] ?? f.default ?? ''))
    .join('');
  const preview = p?.fields?.length
    ? `<p class="hint">Base URL: <code>${escapeHtml(p.baseUrl)}</code></p>`
    : '';
  const note = p?.note ? `<p class="hint">${escapeHtml(p.note)}</p>` : '';
  const flavor = typed.flavor ?? '';
  const customHtml = custom
    ? `<label for="add-x-flavor">API</label><select id="add-x-flavor" data-extra="flavor" class="field">${FLAVORS.map(([v, l]) => `<option value="${v}"${v === flavor ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
  <label for="add-x-headers">Extra headers <span class="muted">(optional, one per line)</span></label><textarea id="add-x-headers" data-extra="headers" class="field" rows="2" spellcheck="false" placeholder="X-Org: my-team">${escapeHtml(typed.headers ?? '')}</textarea>`
    : '';
  return `${fields}${preview}${note}${customHtml}<div id="add-probe-result" class="probe-result">${probeHtml()}</div>`;
}

function probeHtml(): string {
  if (!probe) return '';
  if (probe === 'running') return '<span class="pill busy pulse">testing…</span>';
  const models = probe.models.length
    ? `<div class="hint">${escapeHtml(probe.models.slice(0, 6).join(', '))}${probe.models.length > 6 ? ', …' : ''}</div>`
    : '';
  const url = probe.ok
    ? `<div class="hint">Base URL: <code>${escapeHtml(probe.baseUrl)}</code></div>`
    : '';
  return `<span class="pill ${probe.ok ? 'ok' : 'warn'}">${probe.ok ? '✓' : '✗'} ${escapeHtml(probe.detail)}</span>${url}${models}`;
}

/** Read the extras for a save or test; returns an error message instead when one is malformed. */
export function readExtras(p: FormProvider | undefined, custom: boolean): FormExtras | string {
  const fields: Record<string, string> = {};
  for (const f of p?.fields ?? []) {
    const value = (typed[`f-${f.key}`] ?? f.default ?? '').trim();
    if (!value) return `Enter the ${f.label.toLowerCase()} first`;
    fields[f.key] = value;
  }
  if (!custom) return Object.keys(fields).length ? { fields } : {};
  const lines = (typed.headers ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const m = HEADER_LINE.exec(line);
    if (!m?.[1] || !m[2]) return `"${line}" is not a header: write it as Name: value`;
    headers[m[1]] = m[2];
  }
  const flavor = typed.flavor ?? '';
  return {
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(flavor ? { flavor } : {}),
  };
}

/** Mark a test as running; returns the result box's new HTML. */
export function startProbe(): string {
  probe = 'running';
  return probeHtml();
}

/** A `providerProbe` message from the server; returns the result box's new HTML. */
export function onProbe(m: Record<string, unknown>): string {
  probe = {
    ok: m.ok === true,
    detail: typeof m.detail === 'string' ? m.detail : '',
    baseUrl: typeof m.baseUrl === 'string' ? m.baseUrl : '',
    models: Array.isArray(m.models)
      ? m.models.filter((x): x is string => typeof x === 'string')
      : [],
    ...(typeof m.flavor === 'string' ? { flavor: m.flavor } : {}),
  };
  return probeHtml();
}

/**
 * The server answered a running test with an error (bad input): the result box's new HTML, or
 * undefined when no test was running (the error belongs to something else).
 */
export function probeFailed(message: string): string | undefined {
  if (probe !== 'running') return undefined;
  probe = { ok: false, detail: message, baseUrl: '', models: [] };
  return probeHtml();
}
