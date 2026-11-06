/**
 * Icons and one-line blurbs for MCP servers in settings. Badge unification: the mark is always
 * badge() from badge.ts — two letters on the service's stable hue. No per-server glyphs or
 * letter tables here; the only badge in the webview lives in badge.ts. No DOM, so tests can
 * import it.
 */
import { badge } from './badge.js';

/** The mark for a server: the shared badge, from its display name. */
export function mcpIcon(id: string, name = id): string {
  return badge(name);
}

/** One line on what the server does: the first sentence of the catalog's description. */
export function mcpBlurb(_id: string, description: string): string {
  return description.split(/(?<=[.!?])\s/)[0] ?? '';
}
