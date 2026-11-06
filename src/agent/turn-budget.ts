/**
 * User-settable per-turn input context budget (`tokens_per_turn`, 1k–256k tokens).
 *
 * The allocator turns a budget $B$ into a deterministic `TurnBudgetPlan` that controls how much
 * of every `CompletionRequest` goes to the frozen prefix (Slots 0–6), how many capabilities the
 * kernel mounts, how large a single tool output may be, and where history compaction kicks in.
 *
 * Prompt-cache invariant: the plan is a pure function of $B$ and is computed ONCE per epoch, so
 * `req.tools` and `req.system` stay byte-identical across turns within an epoch (no KV-cache
 * busting). The heavy-section trimming happens in the plan (a compact `SectionModes` snapshot),
 * never by mutating a shared object after the prefix was built.
 */

import {
  TOKENS_PER_TURN_MAX,
  TOKENS_PER_TURN_MIN,
  clampTokensPerTurn,
} from '../core/agent-levels.js';
import { CHARS_PER_TOKEN, estimateTokens } from '../core/tokens.js';
import type { SectionModes } from './sections.js';

/** Budget thresholds that define the three scaling regimes. */
export const TIGHT_BUDGET = 4_000;
export const MID_BUDGET = 64_000;

const ALL_PINNED: SectionModes = {
  role: 'pinned',
  codemap: 'pinned',
  intent: 'pinned',
  lessons: 'pinned',
  progress: 'pinned',
};

/** One section's char budget under a scaled plan. */
export interface TurnBudgetSlotBudgets {
  core: number;
  codemap: number;
  goal: number;
  facts: number;
  lessons: number;
  cycleAnchor: number;
  initialLsf: number;
}

/** A fully-resolved per-turn budget plan. */
export interface TurnBudgetPlan {
  /** The clamped budget $B$. */
  budget: number;
  /**
   * True at tight budgets: heavy sections are on-demand and slots are compressed so Slot 0 +
   * system fit inside ~35–45% of $B$ without blowing a small window.
   */
  heavy: boolean;
  /** Section modes for this budget (pinned vs on-demand recall). */
  sections: SectionModes;
  /** Kernel `max_mounted` cap for this budget (1..16). */
  maxMounted: number;
  /** Per-slot character budgets (Slots 1–7), scaled from the base table. */
  slotBudgets: TurnBudgetSlotBudgets;
  /** Token ceiling for the frozen prefix (Slots 0–6). */
  prefixCeiling: number;
  /** Per-tool output compression ceiling in tokens (keeps a single bash/read from blowing B). */
  toolOutputCeiling: number;
  /** Message-history compaction target in tokens (enforced when `tokens_per_turn` is set). */
  compactionTarget: number;
  /** The irreducible core tool + last-turn floor at 1k. */
  minIrreducibleCore: number;
}

/** The base per-slot char budgets (matched to `context.ts` SLOT_CHAR_BUDGETS). */
const BASE_SLOT_CHAR: Required<TurnBudgetSlotBudgets> = {
  core: 1_000 * CHARS_PER_TOKEN,
  codemap: 1_000 * CHARS_PER_TOKEN,
  goal: 600 * CHARS_PER_TOKEN,
  facts: 400 * CHARS_PER_TOKEN,
  lessons: 500 * CHARS_PER_TOKEN,
  cycleAnchor: 740 * CHARS_PER_TOKEN,
  initialLsf: 2_400 * CHARS_PER_TOKEN,
};

const MIN_SLOT_CHAR = 200;
const MIN_TOOL_OUTPUT_CEILING = 1_200;
const MAX_TOOL_OUTPUT_CEILING = 128_000;
/** The frozen prefix cap from the canonical builder (Slots 0–6). */
export const PREFIX_TOKEN_CEILING = 5_440;

/** Deterministic per-regime scaling factors for $B$. */
function scaleFor(B: number): { slots: number; mounted: number; heavy: boolean } {
  if (B <= TIGHT_BUDGET) {
    const t = (B - TOKENS_PER_TURN_MIN) / Math.max(1, TIGHT_BUDGET - TOKENS_PER_TURN_MIN);
    return { slots: 0.35 + 0.65 * t, mounted: 1 + Math.round(t), heavy: true };
  }
  if (B <= MID_BUDGET) {
    const t = (B - TIGHT_BUDGET) / (MID_BUDGET - TIGHT_BUDGET);
    return { slots: 1 + t, mounted: 3 + Math.round(5 * t), heavy: false };
  }
  const t = (B - MID_BUDGET) / (TOKENS_PER_TURN_MAX - MID_BUDGET);
  return { slots: 2 + 0.5 * t, mounted: 8 + Math.round(8 * t), heavy: false };
}

const sc = (base: number, mult: number, scale: number): number =>
  Math.max(MIN_SLOT_CHAR, Math.round(base * mult * scale));

/**
 * Parse a `--tokens-per-turn` value: a plain integer ("4096") or `k` shorthand ("1k", "16k").
 * Non-numeric/misformatted input throws; out-of-range values clamp to the 1k–256k window.
 */
export function parseTokensPerTurn(v: string): number {
  const s = v.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(s);
  if (!m) throw new Error(`--tokens-per-turn expects a number or "Nk" shorthand, got "${v}"`);
  const value = m[2] ? Math.round(Number(m[1]) * 1000) : Math.round(Number(m[1]));
  return clampTokensPerTurn(value);
}

/**
 * Compute the plan for a clamped budget $B$. Pure and deterministic: the same $B$ always yields
 * the same plan, so an epoch can cache one result and keep `req.tools`/`req.system` stable.
 */
export function computeTurnBudgetPlan(rawB: number): TurnBudgetPlan {
  const B = clampTokensPerTurn(rawB);
  const { slots, mounted, heavy } = scaleFor(B);
  const m = Math.max(1, Math.min(16, mounted));
  const slotBudgets: TurnBudgetSlotBudgets = {
    core: sc(BASE_SLOT_CHAR.core, 1, slots),
    // Heavy sections compress much harder at tight budgets so the prefix stays small.
    codemap: sc(BASE_SLOT_CHAR.codemap, heavy ? 0.15 : 1, slots),
    goal: sc(BASE_SLOT_CHAR.goal, 1, slots),
    facts: sc(BASE_SLOT_CHAR.facts, 1, slots),
    lessons: sc(BASE_SLOT_CHAR.lessons, heavy ? 0.2 : 1, slots),
    cycleAnchor: sc(BASE_SLOT_CHAR.cycleAnchor, 1, slots),
    initialLsf: sc(BASE_SLOT_CHAR.initialLsf, 1, slots),
  };
  const sections: SectionModes = heavy
    ? {
        role: 'pinned',
        codemap: 'optional',
        intent: 'optional',
        lessons: 'optional',
        progress: 'optional',
      }
    : ALL_PINNED;
  return {
    budget: B,
    heavy,
    sections,
    maxMounted: m,
    slotBudgets,
    prefixCeiling: Math.max(
      1_200,
      Math.min(PREFIX_TOKEN_CEILING, Math.round(B * (heavy ? 0.4 : 0.3))),
    ),
    toolOutputCeiling: Math.min(
      MAX_TOOL_OUTPUT_CEILING,
      Math.max(MIN_TOOL_OUTPUT_CEILING, Math.round(B * 0.55)),
    ),
    compactionTarget: Math.max(1_200, Math.round(B * (heavy ? 0.8 : 0.9))),
    minIrreducibleCore: 1_000,
  };
}

/**
 * The allocator: memoizes one plan per budget so a fixed `tokens_per_turn` yields one stable
 * plan per epoch (the prompt-cache invariant). Call `epochPlan` once per epoch boundary.
 */
export class TurnBudgetAllocator {
  private cache = new Map<number, TurnBudgetPlan>();

  planFor(rawB: number): TurnBudgetPlan {
    const B = clampTokensPerTurn(rawB);
    let plan = this.cache.get(B);
    if (!plan) {
      plan = computeTurnBudgetPlan(B);
      this.cache.set(B, plan);
    }
    return plan;
  }
}

/** Estimated request input tokens (system + tools + messages), the same way the loop sizes them. */
export function estimateRequestTokens(
  system: readonly { text: string }[],
  tools: unknown,
  messages: unknown,
): number {
  return estimateTokens(JSON.stringify([system.map((b) => b.text), tools, messages]));
}
