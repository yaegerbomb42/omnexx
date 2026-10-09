import { randomUUID } from 'node:crypto';

/**
 * A minimal A2A (Agent2Agent) client: read an agent's card and send it one text message. Speaks
 * v1.0 (`SendMessage`, `ROLE_USER`, `A2A-Version: 1.0`) and falls back to v0.3
 * (`message/send`, `role: "user"`, parts with `kind`) when a server refuses the new form.
 */

export interface RemoteCard {
  name: string;
  description: string;
  /** The JSON-RPC endpoint messages go to. */
  endpoint: string;
  skills: string[];
}

const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json'];

/** Read an agent card from its URL, or from the well-known paths under a base URL. */
export async function fetchCard(
  url: string,
  fetchFn: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<RemoteCard> {
  const u = new URL(url);
  const tries = u.pathname.endsWith('.json') ? [u.href] : CARD_PATHS.map((p) => new URL(p, u).href);
  let lastErr = '';
  for (const href of tries) {
    try {
      const res = await fetchFn(href, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        lastErr = `${href} answered ${res.status}`;
        continue;
      }
      return toCard((await res.json()) as Record<string, unknown>, href);
    } catch (err) {
      lastErr = `${href}: ${(err as Error).message}`;
    }
  }
  throw new Error(`no agent card found (${lastErr})`);
}

/** The card's JSON-RPC endpoint (v1.0 supportedInterfaces, else the v0.3 top-level url). */
export function toCard(raw: Record<string, unknown>, cardUrl: string): RemoteCard {
  const interfaces = Array.isArray(raw.supportedInterfaces)
    ? (raw.supportedInterfaces as Record<string, unknown>[])
    : [];
  const jsonrpc = interfaces.find(
    (i) =>
      typeof i.url === 'string' &&
      (typeof i.protocolBinding === 'string' ? i.protocolBinding : 'JSONRPC').toUpperCase() ===
        'JSONRPC',
  );
  const endpoint =
    (typeof jsonrpc?.url === 'string' ? jsonrpc.url : undefined) ??
    (typeof raw.url === 'string' ? raw.url : undefined);
  if (!endpoint) throw new Error('the agent card has no JSON-RPC endpoint');
  const skills = Array.isArray(raw.skills)
    ? (raw.skills as Record<string, unknown>[])
        .map((s) => (typeof s.name === 'string' ? s.name : typeof s.id === 'string' ? s.id : ''))
        .filter(Boolean)
    : [];
  return {
    name: typeof raw.name === 'string' ? raw.name : new URL(cardUrl).host,
    description: typeof raw.description === 'string' ? raw.description : '',
    endpoint: new URL(endpoint, cardUrl).href,
    skills,
  };
}

/** Every text part of a SendMessage result: a task's artifacts and status message, or a message. */
export function replyText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const inner = (r.task ?? r.message ?? r) as Record<string, unknown>;
  const texts = (parts: unknown): string[] =>
    Array.isArray(parts)
      ? (parts as Record<string, unknown>[]).flatMap((p) =>
          typeof p.text === 'string' ? [p.text] : [],
        )
      : [];
  const artifacts = Array.isArray(inner.artifacts)
    ? (inner.artifacts as Record<string, unknown>[]).flatMap((a) => texts(a.parts))
    : [];
  const status = (inner.status as Record<string, unknown> | undefined)?.message as
    Record<string, unknown> | undefined;
  return [...texts(inner.parts), ...artifacts, ...texts(status?.parts)].join('\n').trim();
}

async function rpc(
  endpoint: string,
  method: string,
  params: unknown,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; result: unknown } | { ok: false; status: number; error: string }> {
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as {
    result?: unknown;
    error?: { code?: number; message?: string };
  };
  if (!res.ok || body.error)
    return {
      ok: false,
      status: res.status,
      error: body.error?.message ?? `HTTP ${res.status}`,
    };
  return { ok: true, result: body.result };
}

/** Send one message and return the agent's text reply. */
export async function sendMessage(
  card: RemoteCard,
  text: string,
  opts: { fetchFn?: typeof fetch; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  const { fetchFn = fetch, headers = {}, timeoutMs = 300_000 } = opts;
  const messageId = randomUUID();
  const v1 = await rpc(
    card.endpoint,
    'SendMessage',
    { message: { messageId, role: 'ROLE_USER', parts: [{ text }] } },
    { 'A2A-Version': '1.0', ...headers },
    fetchFn,
    timeoutMs,
  );
  if (v1.ok) return replyText(v1.result);
  // A v0.3 server rejects the v1.0 method or shape (often HTTP 400, or method not found).
  const v03 = await rpc(
    card.endpoint,
    'message/send',
    { message: { messageId, role: 'user', parts: [{ kind: 'text', text }], kind: 'message' } },
    headers,
    fetchFn,
    timeoutMs,
  );
  if (v03.ok) return replyText(v03.result);
  throw new Error(`${card.name} refused the message: ${v1.error}; as v0.3: ${v03.error}`);
}
