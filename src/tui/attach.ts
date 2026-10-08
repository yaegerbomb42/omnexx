import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import type { ContentBlock, ImageMediaType } from '../providers/types.js';

const MEDIA: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Image paths in a message: plain, quoted, or as a terminal pastes a dragged file (spaces escaped
 * with backslashes). Paths that don't exist are ignored, so ordinary text never attaches anything.
 */
export function imagePathsIn(text: string): string[] {
  const re =
    /'([^']+\.(?:png|jpe?g|gif|webp))'|"([^"]+\.(?:png|jpe?g|gif|webp))"|((?:\\ |[^\s'"])+\.(?:png|jpe?g|gif|webp))/gi;
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const p = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\ /g, ' ');
    if (p) out.push(p);
  }
  return out;
}

/** Read the images a message points at into content blocks; notes say what was skipped and why. */
export async function attachImages(
  text: string,
  cwd: string,
): Promise<{ blocks: ContentBlock[]; attached: string[]; skipped: string[] }> {
  const blocks: ContentBlock[] = [];
  const attached: string[] = [];
  const skipped: string[] = [];
  for (const raw of imagePathsIn(text)) {
    const p = raw.startsWith('~/')
      ? resolve(homedir(), raw.slice(2))
      : isAbsolute(raw)
        ? raw
        : resolve(cwd, raw);
    const info = await stat(p).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > MAX_IMAGE_BYTES) {
      skipped.push(`${basename(p)} (over 8 MB)`);
      continue;
    }
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const mediaType = MEDIA[ext];
    if (!mediaType) continue;
    blocks.push({ type: 'image', mediaType, data: (await readFile(p)).toString('base64') });
    attached.push(basename(p));
  }
  return { blocks, attached, skipped };
}
