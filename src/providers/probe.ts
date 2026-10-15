import { authHeaders, type EndpointAuth } from './auth-headers.js';
import type { ApiFlavor } from './catalog.js';

/**
 * Work out what an unknown endpoint is from just a base URL and a key: which API it speaks
 * (OpenAI Chat Completions, Anthropic Messages, Gemini), the base URL it really wants (adding a
 * missing /v1), and its models. Every request is a model list or a deliberately invalid tiny
 * request (model "omnexx-probe", 1 token) that a real server rejects without charging.
 */

export interface ProbeInput {
  baseUrl: string;
  apiKey?: string | undefined;
  auth?: EndpointAuth | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  /** Try this flavor first (from the catalog, or the person's pick). */
  flavor?: ApiFlavor | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  flavor: ApiFlavor | undefined;
  /** The base URL to save, possibly corrected (a missing /v1 added). */
  baseUrl: string;
  models: string[];
  /** What happened, in one line for a person. */
  detail: string;
}

interface Answer {
  /** 0 when nothing answered (network error, timeout). */
  status: number;
  body: unknown;
  error?: string;
}

const PROBE_TIMEOUT_MS = 8_000;
const ANTHROPIC_VERSION = '2023-06-01';
const PROBE_MODEL = 'omnexx-probe';

/** A person-readable reason for an HTTP status from `url`. */
export function explainStatus(status: number, url: string): string {
  if (status === 401)
    return '401: key rejected — check the API key (and that it is for this provider)';
  if (status === 403)
    return "403: the key works but isn't allowed here — check its permissions or plan";
  if (status === 404)
    return `404: nothing at ${url} — the base URL probably needs /v1 (or the provider's API path)`;
  if (status === 429) return '429: rate limited or out of credit — the key is accepted';
  if (status >= 500) return `${status}: the server had an error — try again later`;
  return `${status}: unexpected answer from ${url}`;
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** A base URL with no version segment (`/v1`, `/v4`, `/v1beta`) may be missing one. */
function candidates(base: string): string[] {
  return /\/v\d+[a-z]*$/i.test(base) ? [base] : [base, `${base}/v1`];
}

async function call(
  fetchFn: typeof fetch,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<Answer> {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function modelIds(body: unknown, field: 'id' | 'name'): string[] | undefined {
  const list = isObject(body) ? (body.data ?? body.models) : undefined;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((m) => {
    const id = isObject(m) ? m[field] : undefined;
    return typeof id === 'string' && id ? [id.replace(/^models\//, '')] : [];
  });
}

function ok(flavor: ApiFlavor, baseUrl: string, models: string[], extra = ''): ProbeResult {
  const listed = models.length ? `${models.length} models` : 'no model list (type a model name)';
  return {
    ok: true,
    flavor,
    baseUrl,
    models,
    detail: `${FLAVOR_LABEL[flavor]}: ${listed}${extra}`,
  };
}

const FLAVOR_LABEL: Record<ApiFlavor, string> = {
  'openai-chat': 'OpenAI-compatible',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic-compatible',
  gemini: 'Gemini',
};

interface Ctx {
  input: ProbeInput;
  fetchFn: typeof fetch;
  timeoutMs: number;
  base: string;
  seen: { status: number; url: string }[];
}

function openaiHeaders(c: Ctx): Record<string, string> {
  return authHeaders(c.input.apiKey, c.input.auth, c.input.headers);
}

function anthropicHeaders(c: Ctx): Record<string, string> {
  return {
    ...(c.input.headers ?? {}),
    'anthropic-version': ANTHROPIC_VERSION,
    ...(c.input.apiKey && c.input.auth !== 'none' ? { 'x-api-key': c.input.apiKey } : {}),
  };
}

async function listOpenAI(c: Ctx): Promise<ProbeResult | undefined> {
  for (const base of candidates(c.base)) {
    const url = `${base}/models`;
    const a = await call(c.fetchFn, url, { headers: openaiHeaders(c) }, c.timeoutMs);
    c.seen.push({ status: a.status, url });
    const ids = a.status === 200 ? modelIds(a.body, 'id') : undefined;
    if (ids) return ok('openai-chat', base, ids, base === c.base ? '' : ' (added /v1)');
  }
  return undefined;
}

/** Anthropic's SDK appends /v1 itself, so the saved base URL has none. */
function anthropicRoot(base: string): string {
  return base.replace(/\/v1$/i, '');
}

async function listAnthropic(c: Ctx): Promise<ProbeResult | undefined> {
  const root = anthropicRoot(c.base);
  const url = `${root}/v1/models`;
  const a = await call(c.fetchFn, url, { headers: anthropicHeaders(c) }, c.timeoutMs);
  c.seen.push({ status: a.status, url });
  const looksAnthropic = isObject(a.body) && ('has_more' in a.body || 'first_id' in a.body);
  const ids = a.status === 200 && looksAnthropic ? modelIds(a.body, 'id') : undefined;
  return ids ? ok('anthropic', root, ids) : undefined;
}

async function listGemini(c: Ctx): Promise<ProbeResult | undefined> {
  const url = `${c.base}/v1beta/models`;
  const headers = {
    ...(c.input.headers ?? {}),
    ...(c.input.apiKey ? { 'x-goog-api-key': c.input.apiKey } : {}),
  };
  const a = await call(c.fetchFn, url, { headers }, c.timeoutMs);
  c.seen.push({ status: a.status, url });
  const ids = a.status === 200 ? modelIds(a.body, 'name') : undefined;
  return ids ? ok('gemini', c.base, ids) : undefined;
}

/** An error body in the API's own shape means the endpoint exists even without a model list. */
function apiError(a: Answer, flavor: 'openai-chat' | 'anthropic'): boolean {
  if (a.status === 0 || a.status === 404 || a.status === 401 || !isObject(a.body)) return false;
  if (flavor === 'anthropic') return a.body.type === 'error' && isObject(a.body.error);
  return isObject(a.body.error) || Array.isArray(a.body.choices);
}

async function shapeProbe(c: Ctx): Promise<ProbeResult | undefined> {
  const message = [{ role: 'user', content: 'hi' }];
  const chatBody = JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: message });
  for (const base of candidates(c.base)) {
    const url = `${base}/chat/completions`;
    const headers = { 'content-type': 'application/json', ...openaiHeaders(c) };
    const a = await call(c.fetchFn, url, { method: 'POST', headers, body: chatBody }, c.timeoutMs);
    c.seen.push({ status: a.status, url });
    if (apiError(a, 'openai-chat')) return ok('openai-chat', base, []);
  }
  const root = anthropicRoot(c.base);
  const url = `${root}/v1/messages`;
  const headers = { 'content-type': 'application/json', ...anthropicHeaders(c) };
  const a = await call(c.fetchFn, url, { method: 'POST', headers, body: chatBody }, c.timeoutMs);
  c.seen.push({ status: a.status, url });
  return apiError(a, 'anthropic') ? ok('anthropic', root, []) : undefined;
}

/** The most telling failure among everything tried: auth problems beat 404s beat silence. */
function failure(c: Ctx): ProbeResult {
  const pick =
    c.seen.find((s) => s.status === 401 || s.status === 403) ??
    c.seen.find((s) => s.status === 429 || s.status >= 500) ??
    c.seen.find((s) => s.status === 404) ??
    c.seen.find((s) => s.status !== 0);
  const host = (() => {
    try {
      return new URL(c.base).host;
    } catch {
      return c.base;
    }
  })();
  const detail = pick
    ? explainStatus(pick.status, pick.url)
    : `couldn't reach ${host} — is the URL right and the server running?`;
  return { ok: false, flavor: undefined, baseUrl: c.base, models: [], detail };
}

/** Detect an endpoint's API flavor, base URL and models. Never throws. */
export async function probeEndpoint(input: ProbeInput): Promise<ProbeResult> {
  const base = trimBase(input.baseUrl);
  if (!/^https?:\/\/[^\s/]+/i.test(base))
    return {
      ok: false,
      flavor: undefined,
      baseUrl: base,
      models: [],
      detail: 'the URL must start with http:// or https://',
    };
  const c: Ctx = {
    input,
    fetchFn: input.fetch ?? fetch,
    timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
    base,
    seen: [],
  };
  if (input.flavor === 'gemini' || /generativelanguage\.googleapis\.com/i.test(base))
    return (await listGemini(c)) ?? failure(c);
  const anthropicFirst = input.flavor === 'anthropic' || /anthropic/i.test(base);
  const order = anthropicFirst ? [listAnthropic, listOpenAI] : [listOpenAI, listAnthropic];
  for (const step of [...order, shapeProbe]) {
    const found = await step(c);
    if (found) return found;
    if (!c.seen.length || c.seen.every((s) => s.status === 0)) break;
  }
  return failure(c);
}
