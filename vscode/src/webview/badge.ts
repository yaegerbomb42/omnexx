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

/**
 * The quiet details worth showing next to a model: a free tag and a parameter count
 * (8b, 70b, 8x7b) read straight from its id. No DOM, so tests can import it.
 */
export function modelDetailTags(model: string): string[] {
  const tags: string[] = [];
  if (
    model
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .includes('free')
  )
    tags.push('free');
  const size = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?b)(?![a-z0-9])/i.exec(model);
  if (size?.[1]) tags.push(size[1].toLowerCase());
  return tags;
}

/** One model from a connected provider, as the picker and palette list it. */
export interface ModelItem {
  ref: string;
  provider: string;
  model: string;
}
