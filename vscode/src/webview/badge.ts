/** Provider badges: two letters on a stable per-provider hue. No DOM, so tests can import it. */
import { escapeHtml } from './render.js';

/** A stable hue per provider name, so each provider keeps its color everywhere. */
export function providerHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 360;
  return h;
}

export function badge(name: string): string {
  const letters =
    name
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 2)
      .toUpperCase() || '?';
  return `<span class="badge" style="--h:${String(providerHue(name))}">${escapeHtml(letters)}</span>`;
}

/** One model from a connected provider, as the picker and palette list it. */
export interface ModelItem {
  ref: string;
  provider: string;
  model: string;
}
