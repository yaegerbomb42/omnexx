import { z } from 'zod';

/**
 * Model profiles for the W3 router (W4 workstream). Profiles live in the user/project
 * config under `[models.profiles."<provider>:<model>"]`. This file must stay in sync
 * with the W3 contract: ModelProfile { id, provider, tags, contextWindow,
 * supportsTools, vision, speedTier, qualityTier }.
 */

// INTEGRATION (W4 -> W0): the core `models` schema (src/config/schema.ts, modelsSchema)
// is a strictObject without `profiles`, so `[models.profiles...]` tables are rejected
// today. Merge this shape in, e.g. `profiles: z.record(z.string(),
// modelProfileSchema).default({})` (import the schema from
// '../sections/models-profiles.js' or move it into schema.ts). Until then, profiles
// are read by loadModelProfiles() below, which parses the raw TOML `models` table
// directly and tolerates a missing/foreign shape.
export const modelProfileSchema = z.strictObject({
  tags: z.array(z.string().min(1)).default([]),
  context: z.number().int().positive().optional(),
  tools: z.boolean().default(true),
  vision: z.boolean().default(false),
  speed: z.enum(['fast', 'normal', 'slow']).default('normal'),
  quality: z.enum(['low', 'mid', 'high']).default('mid'),
});
export type ModelProfileInput = z.infer<typeof modelProfileSchema>;

/** One model profile as the W3 router consumes it. */
export interface ModelProfile {
  /** Full ref, e.g. "groq:llama-3.3-70b-versatile". */
  id: string;
  provider: string;
  tags: string[];
  contextWindow: number | undefined;
  supportsTools: boolean;
  vision: boolean;
  speedTier: 'fast' | 'normal' | 'slow';
  qualityTier: 'low' | 'mid' | 'high';
}

export const modelsProfilesSchema = z.strictObject({
  profiles: z.record(z.string(), modelProfileSchema).default({}),
});
export type ModelsProfilesConfig = z.infer<typeof modelsProfilesSchema>;

function splitRef(ref: string): { provider: string; model: string } {
  const cut = ref.indexOf(':');
  return { provider: ref.slice(0, cut), model: ref.slice(cut + 1) };
}

/** Profiles as a list in deterministic (sorted) order for a stable prompt prefix. */
export function listProfiles(
  profiles: Record<string, ModelProfileInput> | undefined,
): ModelProfile[] {
  return Object.entries(profiles ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ref, p]) => {
      const { provider } = splitRef(ref);
      return {
        id: ref,
        provider,
        tags: [...p.tags],
        contextWindow: p.context,
        supportsTools: p.tools,
        vision: p.vision,
        speedTier: p.speed,
        qualityTier: p.quality,
      };
    });
}

/** Look up one profile by full ref; undefined when not configured. */
export function findProfile(
  profiles: Record<string, ModelProfileInput> | undefined,
  ref: string,
): ModelProfile | undefined {
  const raw = profiles?.[ref];
  if (!raw) return undefined;
  const { provider } = splitRef(ref);
  return {
    id: ref,
    provider,
    tags: [...raw.tags],
    contextWindow: raw.context,
    supportsTools: raw.tools,
    vision: raw.vision,
    speedTier: raw.speed,
    qualityTier: raw.quality,
  };
}

/**
 * Read `[models.profiles.*]` from raw (unvalidated) config data. Tolerates the core
 * schema not knowing `profiles` yet: parses only the nested table, fails soft to {}.
 */
export function loadModelProfiles(rawModels: unknown): Record<string, ModelProfileInput> {
  if (typeof rawModels !== 'object' || rawModels === null) return {};
  const profiles = (rawModels as Record<string, unknown>).profiles;
  if (typeof profiles !== 'object' || profiles === null) return {};
  const out: Record<string, ModelProfileInput> = {};
  for (const [ref, value] of Object.entries(profiles)) {
    if (typeof ref !== 'string' || !ref.includes(':')) continue;
    const parsed = modelProfileSchema.safeParse(value ?? {});
    if (parsed.success) out[ref] = parsed.data;
  }
  return out;
}
