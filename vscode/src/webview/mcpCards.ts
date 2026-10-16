/**
 * MCP gallery and registry cards for settings: the messages from chat-server turned into cards,
 * and each card drawn with its icon and a one-line "what it does". No DOM, so tests can import it.
 */
import { mcpBlurb, mcpIcon } from './mcpIcons.js';
import { escapeHtml } from './render.js';

const asText = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

export interface Need {
  key: string;
  help?: string;
  description?: string;
  target: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

/** A gallery entry or a registry hit, as one card. */
export interface Card {
  via: 'gallery' | 'registry';
  id: string;
  name: string;
  description: string;
  sub: string;
  needs: Need[];
  note?: string;
  oauth?: boolean;
  trusted?: boolean;
}

/** A gallery or registry card: icon, name, a one-line "what it does" and how it runs. */
export function cardHtml(c: Card, on = false): string {
  const about = mcpBlurb(c.id, c.description) || c.sub;
  return `<button class="mcp-card${on ? ' on' : ''}" data-mcp-card="${escapeHtml(c.via)}:${escapeHtml(c.id)}" title="${escapeHtml(c.description)}" aria-pressed="${String(on)}">${mcpIcon(c.via === 'gallery' ? c.id : c.name, c.name)}<span class="mc-text"><span class="mc-name">${escapeHtml(c.name)}${c.trusted ? ' <span class="mc-ok" title="Known publisher">✓</span>' : ''}</span><span class="mc-about">${escapeHtml(about)}</span><span class="mc-sub">${escapeHtml(c.sub)}</span></span></button>`;
}

export function toCards(m: Record<string, unknown>): Card[] {
  const entries = Array.isArray(m.entries) ? (m.entries as Record<string, unknown>[]) : [];
  return entries.map((e) => ({
    via: 'gallery',
    id: String(e.id),
    name: String(e.name),
    description: asText(e.description),
    sub: e.oauth ? 'sign in' : e.url ? 'remote' : asText(e.command),
    needs: (e.needs as Need[] | undefined) ?? [],
    ...(typeof e.note === 'string' ? { note: e.note } : {}),
    oauth: e.oauth === true,
  }));
}

export function registryCards(m: Record<string, unknown>): Card[] {
  const hits = Array.isArray(m.hits) ? (m.hits as Record<string, unknown>[]) : [];
  return hits.map((h) => ({
    via: 'registry',
    id: String(h.id),
    name: String(h.title ?? h.name),
    description: asText(h.description, 'No description from the registry'),
    sub: [asText(h.publisher), asText(h.runs)].filter(Boolean).join(' · '),
    needs: (h.needs as Need[] | undefined) ?? [],
    note: `Runs ${asText(h.runs, 'as listed')}${h.trusted ? '' : '. Not a known publisher: check it first'}.`,
    trusted: h.trusted === true,
  }));
}
