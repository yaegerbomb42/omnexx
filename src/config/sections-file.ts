import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SECTION_IDS, SECTION_MODES, type SectionId, type SectionMode } from '../agent/sections.js';
import type { OmnexxPaths } from '../core/paths.js';

/** Section modes set in the editor's Context explorer, kept next to roles.json. */
export const sectionsFile = (p: OmnexxPaths): string => join(p.configHome, 'context-sections.json');

export async function readSectionModes(
  p: OmnexxPaths,
): Promise<Partial<Record<SectionId, SectionMode>>> {
  try {
    const raw = JSON.parse(await readFile(sectionsFile(p), 'utf8')) as Record<string, unknown>;
    const out: Partial<Record<SectionId, SectionMode>> = {};
    for (const id of SECTION_IDS) {
      const m = raw[id];
      if (typeof m === 'string' && (SECTION_MODES as readonly string[]).includes(m))
        out[id] = m as SectionMode;
    }
    return out;
  } catch {
    return {};
  }
}

/** The modes as a config layer (only the sections that were set). */
export function sectionsLayer(
  modes: Partial<Record<SectionId, SectionMode>>,
): Record<string, unknown> | undefined {
  return Object.keys(modes).length ? { context: { sections: modes } } : undefined;
}
