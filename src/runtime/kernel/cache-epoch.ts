/**
 * Prompt-cache epochs for the kernel.
 *
 * Anthropic-style prefix caching bills a re-read at ~0.1x and a (re)write at ~1.25x of the
 * uncached input price. `tools` render FIRST in the prefix, so any change to the tool list
 * (a capability mounted or unmounted mid-chat) rewrites the whole conversation at 1.25x.
 *
 * So within an epoch `req.tools` is frozen: the tool specs baked at epoch start plus
 * `call_capability` (and the catalog's `manage_capabilities`). Capabilities mounted later are
 * announced in the per-turn terminal directive (after the last cached message) and are
 * executable both directly by name and through `call_capability`. The tool list is re-baked
 * only at an epoch boundary: task start, a compaction/condense (the message prefix is being
 * rewritten anyway), or when keeping the extras outside the prefix costs more than a bust.
 */
import { z } from 'zod';
import type { ToolSpec } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { fail } from '../../tools/types.js';
import { toolSpec } from '../../tools/registry.js';
import { LEGACY_CATALOG_TOOLS } from './catalog.js';

export const CALL_CAPABILITY = 'call_capability';
/** Billing multipliers relative to uncached input (Anthropic 5m TTL). */
export const CACHE_READ_PRICE = 0.1;
export const CACHE_WRITE_PRICE = 1.25;

export const estimateTokens = (v: unknown): number =>
  Math.ceil((typeof v === 'string' ? v : JSON.stringify(v)).length / 4);

export interface CacheEconomyInput {
  /** Prompt tokens a fold removes. */
  freedTokens: number;
  /** Turns the smaller prompt will be re-read for. */
  expectedRemainingTurns: number;
  /** Tokens after the change point that must be rewritten (cache written again). */
  suffixTokensToBust: number;
  /** Uncached tokens saved by the fold every turn (e.g. extras no longer resent uncached). */
  uncachedSavings?: number;
  cachedReadPrice?: number;
  cacheWritePrice?: number;
}

/**
 * Cache-amortization inequality: folding/re-baking pays off only when
 *   freed * remaining * read + uncachedSavings * remaining  >  bust * (1 - read) + writePremium
 * where writePremium = bust * (write - 1).
 */
export function foldPaysOff(i: CacheEconomyInput): boolean {
  const read = i.cachedReadPrice ?? CACHE_READ_PRICE;
  const write = i.cacheWritePrice ?? CACHE_WRITE_PRICE;
  const remaining = Math.max(0, i.expectedRemainingTurns);
  const gain = i.freedTokens * remaining * read + (i.uncachedSavings ?? 0) * remaining;
  const cost = i.suffixTokensToBust * (1 - read) + i.suffixTokensToBust * (write - 1);
  return gain > cost;
}

/** Compact one-line signature for a tool announced outside the frozen prefix. */
export function capabilitySignature(spec: ToolSpec): string {
  const schema = spec.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const req = new Set(schema.required ?? []);
  const params = Object.keys(schema.properties ?? {})
    .sort()
    .map((p) => (req.has(p) ? p : `${p}?`))
    .join(', ');
  const desc = spec.description.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `- ${spec.name}(${params}) — ${desc}`;
}

export function capabilityDirective(extra: readonly ToolSpec[]): string | undefined {
  if (!extra.length) return undefined;
  return [
    `[kernel:mounted_capabilities] Mounted since this tool list was frozen; call them by name or via ${CALL_CAPABILITY}({tool_name, arguments}):`,
    ...[...extra].sort((a, b) => a.name.localeCompare(b.name)).map(capabilitySignature),
  ].join('\n');
}

/** The proxy tool: runs any currently mounted capability by name. */
export function callCapabilityTool(resolve: (name: string) => Tool | undefined): Tool {
  const schema = z.object({
    capability_id: z.string().optional().describe('Catalog id of the capability (optional)'),
    tool_name: z.string().describe('Name of the mounted tool to run'),
    arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments for that tool'),
  });
  const tool: Tool<typeof schema> = {
    name: CALL_CAPABILITY,
    description:
      'Run a capability mounted after the tool list was frozen (listed under [kernel:mounted_capabilities]). Pass its tool_name and arguments.',
    schema,
    readOnly: false,
    async run(input, ctx) {
      const target = resolve(input.tool_name);
      if (!target || target.name === CALL_CAPABILITY)
        return fail(`capability tool ${input.tool_name} is not mounted`);
      const raw = target.normalize
        ? target.normalize(input.arguments ?? {})
        : (input.arguments ?? {});
      const parsed = target.schema.safeParse(raw);
      if (!parsed.success)
        return fail(`invalid arguments for ${target.name}: ${parsed.error.message}`);
      return target.run(parsed.data, ctx);
    },
  };
  return tool;
}

export interface EpochPlan {
  /** Byte-stable tool specs for req.tools this turn. */
  specs: ToolSpec[];
  /** Mounted tools whose specs are NOT in the frozen prefix (announced in the directive). */
  extra: ToolSpec[];
  /** Every tool executable this turn (frozen ∪ mounted ∪ call_capability), by name. */
  byName: Map<string, Tool>;
  rebaked: boolean;
  epoch: number;
}

export interface EpochInput {
  /** Tools the kernel mounted for this turn. */
  mounted: readonly Tool[];
  /** The message prefix is being rewritten this turn anyway (compaction/condense/GC). */
  fold?: boolean;
  /** Estimated prompt tokens after the tools (system + messages) that a re-bake would rewrite. */
  suffixTokens?: number;
  expectedRemainingTurns?: number;
  /** Tokens before the fold's change point (bust only a re-bake adds). */
  foldBustTokens?: number;
}

export class ToolEpoch {
  private frozen: ToolSpec[] | undefined;
  private frozenTools = new Map<string, Tool>();
  private epochNo = 0;
  private readonly proxy: Tool;
  private current = new Map<string, Tool>();

  constructor() {
    this.proxy = callCapabilityTool((n) => this.current.get(n) ?? this.frozenTools.get(n));
  }

  get epoch(): number {
    return this.epochNo;
  }

  plan(i: EpochInput): EpochPlan {
    this.current = new Map(i.mounted.map((t) => [t.name, t]));
    const frozenNames = new Set(this.frozen?.map((s) => s.name) ?? []);
    // Legacy catalog meta-tools stay callable but never enter (or bust) Slot 0.
    const prefixable = i.mounted.filter((t) => !LEGACY_CATALOG_TOOLS.has(t.name));
    let extraTools = prefixable.filter((t) => !frozenNames.has(t.name));
    let rebaked = false;
    const extraTokens = estimateTokens(extraTools.map((t) => toolSpec(t)));
    const shouldBake =
      !this.frozen ||
      // At a fold only the part before the fold's change point (system + first message) is
      // an extra bust; re-bake when keeping extras out of the prefix costs more than that.
      (i.fold === true &&
        (extraTools.length > 0 || this.staleCount(i.mounted) > 0) &&
        foldPaysOff({
          freedTokens: estimateTokens(this.staleSpecs(i.mounted)),
          uncachedSavings: extraTokens * (1 - CACHE_READ_PRICE),
          expectedRemainingTurns: i.expectedRemainingTurns ?? 8,
          suffixTokensToBust:
            estimateTokens(this.frozen) +
            extraTokens +
            (i.foldBustTokens ?? Math.round((i.suffixTokens ?? 0) * 0.25)),
        })) ||
      (extraTools.length > 0 &&
        foldPaysOff({
          freedTokens: 0,
          uncachedSavings: extraTokens * (1 - CACHE_READ_PRICE),
          expectedRemainingTurns: i.expectedRemainingTurns ?? 8,
          suffixTokensToBust: (i.suffixTokens ?? 0) + extraTokens,
        }));
    if (shouldBake) {
      const tools = [...prefixable.filter((t) => t.name !== CALL_CAPABILITY), this.proxy];
      this.frozen = tools.map(toolSpec).sort((a, b) => a.name.localeCompare(b.name));
      this.frozenTools = new Map(tools.map((t) => [t.name, t]));
      this.epochNo += 1;
      extraTools = [];
      rebaked = true;
    }
    const byName = new Map<string, Tool>(this.frozenTools);
    for (const t of i.mounted) byName.set(t.name, t);
    byName.set(CALL_CAPABILITY, this.proxy);
    return {
      specs: this.frozen ?? [],
      extra: extraTools.map(toolSpec),
      byName,
      rebaked,
      epoch: this.epochNo,
    };
  }

  private staleSpecs(mounted: readonly Tool[]): ToolSpec[] {
    const live = new Set(mounted.map((t) => t.name));
    return [...this.frozenTools.values()]
      .filter((t) => t.name !== CALL_CAPABILITY && !live.has(t.name))
      .map(toolSpec);
  }

  /** Frozen tools no longer mounted (dead weight a fold can drop). */
  private staleCount(mounted: readonly Tool[]): number {
    const live = new Set(mounted.map((t) => t.name));
    return [...this.frozenTools.keys()].filter((n) => n !== CALL_CAPABILITY && !live.has(n)).length;
  }
}
