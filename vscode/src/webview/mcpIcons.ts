/**
 * Icons and one-line blurbs for MCP servers in settings: a small glyph for the generic dev
 * servers, a letter mark on the service's color for apps, and a colored letter badge for anything
 * else (registry hits, servers you added by hand). No DOM, so tests can import it.
 */
import { providerHue } from './badge.js';
import { escapeHtml } from './render.js';

interface Look {
  /** Background color of the mark. */
  color: string;
  /** Inner SVG (24×24, stroked white); letters are used when absent. */
  glyph?: string;
  letters?: string;
  /** A short "what it does", when the catalog's text is only a category or a how-to. */
  blurb?: string;
}

const LOOKS: Record<string, Look> = {
  filesystem: { color: '#c08a2e', glyph: '<path d="M3 7h6l2 2h10v9H3z"/>' },
  playwright: {
    color: '#2ead33',
    glyph: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  },
  fetch: { color: '#3178c6', glyph: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>' },
  memory: {
    color: '#8b5cf6',
    glyph:
      '<circle cx="6" cy="12" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 11l8-4M8 13l8 4"/>',
  },
  'sequential-thinking': {
    color: '#0ea5a4',
    glyph: '<path d="M5 6h4M5 12h8M5 18h12"/><circle cx="19" cy="6" r="1.5"/>',
  },
  context7: { color: '#10b981', glyph: '<path d="M4 5h7v14H4zM13 5h7v14h-7z"/>' },
  postgres: {
    color: '#336791',
    glyph:
      '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  },
  sqlite: {
    color: '#0f80cc',
    glyph: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  },
  email: {
    color: '#64748b',
    glyph: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    blurb: 'Read, search and send email over IMAP/SMTP',
  },
  google: {
    color: '#4285f4',
    letters: 'G',
    blurb: 'Gmail, Calendar, Drive, Docs and Sheets in one sign-in',
  },
  gmail: { color: '#ea4335', letters: 'M', blurb: 'Search, read and draft your Gmail' },
  'google-calendar': {
    color: '#1a73e8',
    letters: '31',
    blurb: 'See and plan events on your calendar',
  },
  'google-drive': {
    color: '#0f9d58',
    letters: 'D',
    blurb: 'Find and edit Drive files, Docs and Sheets',
  },
  slack: { color: '#4a154b', letters: '#', blurb: 'Read channels and post messages' },
  notion: { color: '#191919', letters: 'N', blurb: 'Search and edit your Notion pages' },
  dropbox: { color: '#0061fe', letters: 'Db', blurb: 'Browse and fetch your Dropbox files' },
  canva: { color: '#00c4cc', letters: 'C', blurb: 'Find and create Canva designs' },
  airtable: { color: '#f82b60', letters: 'At', blurb: 'Query and update Airtable bases' },
  linear: { color: '#5e6ad2', letters: 'L', blurb: 'Read and file Linear issues' },
  atlassian: { color: '#0052cc', letters: 'J', blurb: 'Jira issues and Confluence pages' },
  monday: { color: '#ff3d57', letters: 'm', blurb: 'Boards and items on monday.com' },
  todoist: { color: '#e44332', letters: 'T', blurb: 'Your Todoist tasks and projects' },
  github: { color: '#24292f', letters: 'GH', blurb: 'Issues, pull requests and code on GitHub' },
  gitlab: { color: '#fc6d26', letters: 'GL', blurb: 'Issues, merge requests and pipelines' },
  sentry: { color: '#362d59', letters: 'S', blurb: 'Look up errors and their stack traces' },
  supabase: { color: '#3ecf8e', letters: 'Sb', blurb: 'Your Supabase database, auth and storage' },
  cloudflare: { color: '#f38020', letters: 'CF', blurb: 'Workers, KV, R2 and D1 on Cloudflare' },
  stripe: { color: '#635bff', letters: 'S', blurb: 'Customers, payments and invoices' },
  paypal: { color: '#003087', letters: 'P', blurb: 'Orders, invoices and payouts' },
  hubspot: { color: '#ff7a59', letters: 'H', blurb: 'Contacts, deals and companies in your CRM' },
};

const lettersOf = (name: string): string =>
  name
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 2)
    .replace(/^./, (c) => c.toUpperCase()) || '?';

/** The mark for a server id or name: its glyph, its letters on its color, or a hue badge. */
export function mcpIcon(id: string, name = id): string {
  const look = LOOKS[id.toLowerCase()];
  if (look?.glyph)
    return `<span class="mcp-icon" style="--ic:${look.color}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${look.glyph}</svg></span>`;
  if (look)
    return `<span class="mcp-icon" style="--ic:${look.color}">${escapeHtml(look.letters ?? lettersOf(name))}</span>`;
  return `<span class="mcp-icon" style="--ic:hsl(${String(providerHue(id))} 55% 42%)">${escapeHtml(lettersOf(name))}</span>`;
}

/** One line on what the server does: our blurb when the catalog only has a category or how-to. */
export function mcpBlurb(id: string, description: string): string {
  const blurb = LOOKS[id.toLowerCase()]?.blurb;
  const plain = description.split(/(?<=[.!?])\s/)[0] ?? '';
  return blurb ?? plain;
}
