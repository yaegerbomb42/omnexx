import type { ModelProfileConfig, OmnexxConfig } from '../config/schema.js';
import { resolveModel, type ResolvedModel } from '../providers/pricing.js';
import type { Role } from './actions.js';

export interface Candidate {
  ref: string;
  model: ResolvedModel;
  /** Role chains this model appears in. */
  roles: Role[];
  profile: ModelProfileConfig;
  quality: 'low' | 'mid' | 'high';
  speed: 'fast' | 'normal' | 'slow';
}

const ROLE_QUALITY: Record<Role, Candidate['quality']> = {
  planner: 'high',
  worker: 'mid',
  cheap: 'low',
};
const ROLE_SPEED: Record<Role, Candidate['speed']> = {
  planner: 'slow',
  worker: 'normal',
  cheap: 'fast',
};
const RANK = { low: 0, mid: 1, high: 2 } as const;

const refsOf = (c: string | readonly string[]): readonly string[] =>
  typeof c === 'string' ? [c] : c;

/**
 * Every model the user configured (role chains plus `models.extra`), deduplicated in a stable
 * order. Quality and speed come from the profile, else from the strongest role the model holds.
 */
export function listCandidates(config: OmnexxConfig): Candidate[] {
  const m = config.models;
  const byRef = new Map<string, Role[]>();
  const add = (ref: string, role?: Role): void => {
    const roles = byRef.get(ref) ?? [];
    if (role && !roles.includes(role)) roles.push(role);
    byRef.set(ref, roles);
  };
  for (const role of ['planner', 'worker', 'cheap'] as const) {
    for (const ref of refsOf(m[role])) add(ref, role);
  }
  for (const ref of m.extra) add(ref);
  return [...byRef].map(([ref, roles]) => {
    const profile = m.profiles[ref] ?? { tags: [], tools: true, vision: false };
    const best = roles.reduce<Role | undefined>(
      (a, r) => (!a || RANK[ROLE_QUALITY[r]] > RANK[ROLE_QUALITY[a]] ? r : a),
      undefined,
    );
    return {
      ref,
      model: resolveModel(ref, config),
      roles,
      profile,
      quality: profile.quality ?? (best ? ROLE_QUALITY[best] : 'mid'),
      speed: profile.speed ?? (best ? ROLE_SPEED[best] : 'normal'),
    };
  });
}

export interface Needs {
  tools?: boolean;
  vision?: boolean;
  /** Tokens the call will need in context. */
  context?: number;
  minQuality?: Candidate['quality'];
}

/** Why a candidate can't take the action, or undefined if it can. */
export function unfit(c: Candidate, needs: Needs): string | undefined {
  if (needs.tools && !c.profile.tools) return 'no tool use';
  if (needs.vision && !c.profile.vision) return 'no vision';
  if (needs.context && c.profile.context && c.profile.context < needs.context)
    return `context ${c.profile.context} < ${needs.context}`;
  if (needs.minQuality && RANK[c.quality] < RANK[needs.minQuality]) return `quality ${c.quality}`;
  return undefined;
}

/** A short description the judge reads for each option. */
export function describe(c: Candidate): string {
  const bits = [
    `quality ${c.quality}`,
    `speed ${c.speed}`,
    c.profile.context ? `context ${Math.round(c.profile.context / 1000)}k` : undefined,
    c.profile.vision ? 'vision' : undefined,
    c.profile.tags.length ? `tags ${c.profile.tags.join('/')}` : undefined,
    c.model.price.input || c.model.price.output
      ? `$${c.model.price.input}/$${c.model.price.output} per MTok`
      : 'free',
  ];
  return `${c.ref}: ${bits.filter(Boolean).join(', ')}`;
}
