import { createHash } from 'node:crypto';
import { compactPlanView, type Plan, type PlanNode } from '../core/plan.js';
import { CHARS_PER_TOKEN } from '../core/tokens.js';
import { contentsBlock, type SectionId, type SectionModes } from './sections.js';
import type { CompletionRequest, Message, SystemBlock, ToolSpec } from '../providers/types.js';

/** Hard ceiling for the Frozen Prefix (Slots 0–6) so Slots 0–11 stay <= 10,240 tokens. */
export const PREFIX_TOKEN_CEILING = 5_440;

/** Per-slot character budgets (4 chars/token) for Slots 1–6. */
const SLOT_CHAR_BUDGETS = {
  core: 1_000 * CHARS_PER_TOKEN,
  codemap: 1_000 * CHARS_PER_TOKEN,
  goal: 600 * CHARS_PER_TOKEN,
  facts: 400 * CHARS_PER_TOKEN,
  lessons: 500 * CHARS_PER_TOKEN,
  cycleAnchor: 740 * CHARS_PER_TOKEN,
  initialLsf: 2_400 * CHARS_PER_TOKEN,
} as const;

/** Everything a cycle starts from. Built from disk each cycle; nothing carries over. */
export interface CycleInputs {
  systemPrompt: string;
  codemap: string;
  goal: string;
  /** intent.md from the initial planner; empty until written. */
  intent?: string;
  notes: string;
  plan: Plan;
  task: PlanNode;
  progressTail: string;
  /** Harness-generated evidence about this task: failures, rejected patch summaries, judge notes. */
  evidence: string[];
  /**
   * Salience-ranked progress and evidence from the memory harness. When set it replaces the
   * plain progress and evidence sections; it lives in the per-cycle message, after the
   * system breakpoint, so it never invalidates the cached prefix.
   */
  memory?: string;
  /** The task's running context: the agent's own living memory from earlier cycles. */
  runningContext?: string;
  /** The task's role card (who the agent is for it, what done means). */
  role?: string;
  /** What the user's agent settings mean (effort, time); a volatile block after the goal. */
  brief?: string;
  /** The repo's verified facts (how it builds and tests); a volatile block after the settings. */
  facts?: string;
  /** How each section reaches the model; all pinned when unset (the old behaviour). */
  sections?: SectionModes;
  tools: ToolSpec[];
  /** Optional repo root directory to normalize absolute paths into $REPO references in prefix. */
  repoRoot?: string;
}

const ALL_PINNED: SectionModes = {
  role: 'pinned',
  codemap: 'pinned',
  intent: 'pinned',
  lessons: 'pinned',
  progress: 'pinned',
};

const clampSlot = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars - 24)}\n...[slot-truncated]`;

/**
 * Recursively sort JSON object keys to guarantee deterministic byte serialization for schemas.
 */
export function sortJsonKeys(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map((item) => sortJsonKeys(item));
  }
  const obj = val as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortJsonKeys(obj[key]);
  }
  return sorted;
}

/**
 * Normalizes text to UTF-8 Unicode NFC normalization form and standardizes line endings (\r\n -> \n).
 * Replaces repo absolute path with '$REPO' if repoRoot is supplied.
 */
export function canonicalizePrefixText(text: string, repoRoot?: string): string {
  let normalized = text.normalize('NFC').replace(/\r\n/g, '\n');
  if (repoRoot) {
    const cleanRoot = repoRoot.replace(/[/\\]+$/, '');
    if (cleanRoot.length > 0) {
      normalized = normalized.split(cleanRoot).join('$REPO');
    }
  }
  return normalized;
}

/**
 * Deterministically sort ToolSpecs by name and sort inputSchema object keys so Slot 0 never
 * invalidates the provider KV-cache due to object registration order changes or schema key jitter.
 */
export function canonicalizeTools(tools: readonly ToolSpec[], repoRoot?: string): ToolSpec[] {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: canonicalizePrefixText(t.description, repoRoot),
      inputSchema: (sortJsonKeys(t.inputSchema) ?? {}) as Record<string, unknown>,
    }));
}

/**
 * Computes a deterministic SHA-256 hash of the frozen prefix (Slot 0 tools + Slots 1-6 content).
 */
export function computePrefixHash(
  tools: readonly ToolSpec[],
  system: readonly SystemBlock[],
  cycleAnchor: string,
): string {
  const hash = createHash('sha256');
  // Hash Slot 0 tools
  for (const t of tools) {
    hash.update(`tool:${t.name}:${t.description}:${JSON.stringify(t.inputSchema)}\n`);
  }
  // Hash Slots 1-5 system blocks
  for (const s of system) {
    hash.update(`system:${s.text}\n`);
  }
  // Hash Slot 6 cycle anchor
  hash.update(`anchor:${cycleAnchor}\n`);
  return hash.digest('hex');
}

/**
 * 12-Slot Canonical Context Builder:
 * - Slot 0: Canonical `tools` (sorted, immutable across normal + terminal turns)
 * - Slots 1–5: Fixed-order `system` blocks with Cache Breakpoint #1 on the final system block
 * - Slot 6: `first.content[0]` — Frozen Cycle Anchor (`# Plan`, `# Negative Knowledge`, TOC, `# Task`)
 * - Slot 7: `first.content[1]` — Initial Living State Frame (progress, evidence, runningContext)
 *
 * Separating Slot 6 and Slot 7 into distinct content blocks inside `first` ensures that when
 * `compaction.ts` folds older turns into Slot 7, Slot 6 remains 100% byte-identical.
 */
export function buildCycleContext(i: CycleInputs): {
  system: SystemBlock[];
  first: Message;
  tools: ToolSpec[];
  /** One name per system block, for the context breakdown. */
  labels: string[];
  /** Deterministic SHA-256 digest of Frozen Prefix Slots 0-6. */
  prefixHash: string;
} {
  const modes = i.sections ?? ALL_PINNED;
  const optional: { id: SectionId; text: string }[] = [];

  /** Pinned: send it. Optional: list it in the table of contents. Hidden: neither. */
  const keep = (id: SectionId, text: string | undefined): boolean => {
    if (!text?.trim()) return false;
    if (modes[id] === 'optional') optional.push({ id, text });
    return modes[id] === 'pinned';
  };

  // --- SLOTS 1–5: FROZEN SYSTEM PREFIX ---
  const blocks: { label: string; text: string }[] = [
    // Slot 1: Core System Identity
    {
      label: 'system',
      text: canonicalizePrefixText(
        clampSlot(i.systemPrompt.trim(), SLOT_CHAR_BUDGETS.core),
        i.repoRoot,
      ),
    },
  ];

  // Slot 2: Repository Codemap
  if (keep('codemap', i.codemap)) {
    blocks.push({
      label: 'codemap',
      text: canonicalizePrefixText(
        clampSlot(i.codemap.trim(), SLOT_CHAR_BUDGETS.codemap),
        i.repoRoot,
      ),
    });
  }

  // Slot 3: Goal + Planner Intent
  const intent = keep('intent', i.intent) ? `\n\n${(i.intent ?? '').trim()}` : '';
  blocks.push({
    label: 'goal',
    text: canonicalizePrefixText(
      clampSlot(`# Goal\n\n${i.goal.trim()}${intent}`, SLOT_CHAR_BUDGETS.goal),
      i.repoRoot,
    ),
  });

  // Slot 4: Runtime Settings (brief) & Verified Repo Facts
  if (i.brief?.trim()) {
    blocks.push({
      label: 'settings',
      text: canonicalizePrefixText(clampSlot(i.brief.trim(), SLOT_CHAR_BUDGETS.facts), i.repoRoot),
    });
  }
  if (i.facts?.trim()) {
    blocks.push({
      label: 'facts',
      text: canonicalizePrefixText(clampSlot(i.facts.trim(), SLOT_CHAR_BUDGETS.facts), i.repoRoot),
    });
  }

  // Slot 5: Cross-Cycle Lessons (notes.md)
  if (keep('lessons', i.notes)) {
    blocks.push({
      label: 'notes',
      text: canonicalizePrefixText(
        clampSlot(`# Lessons (notes.md)\n\n${i.notes.trim()}`, SLOT_CHAR_BUDGETS.lessons),
        i.repoRoot,
      ),
    });
  }

  const system: SystemBlock[] = blocks.map((b, n) => ({
    text: b.text,
    ...(n > 0 ? { volatile: true } : {}),
    ...(n === blocks.length - 1 ? { cacheBreakpoint: true } : {}),
  }));

  // --- SLOT 6: FROZEN CYCLE ANCHOR (first.content[0]) ---
  const slot6Parts: string[] = [`# Plan\n\n${compactPlanView(i.plan, i.task.id)}`];

  if (i.task.approachesTried.length || i.task.lastRejection) {
    const lines = [
      ...i.task.approachesTried.map((a) => `- [failed approach] ${a}`),
      ...(i.task.lastRejection ? [`- [last rejection] ${i.task.lastRejection}`] : []),
    ];
    slot6Parts.push(
      `# Negative Knowledge & Dead Ends for ${i.task.id} (do not repeat these)\n\n${lines.join('\n')}`,
    );
  }

  if (keep('role', i.role)) {
    slot6Parts.push((i.role ?? '').trim());
  }

  // Evaluate progress mode before building TOC so optional progress is registered in `optional`.
  const rawProgress = i.memory ?? (i.progressTail ? `# Recent progress\n\n${i.progressTail}` : '');
  const includeProgress = keep('progress', rawProgress);

  const contents = contentsBlock(optional);
  if (contents) slot6Parts.push(contents);

  slot6Parts.push(
    `# Your task now\n\nWork on ${i.task.id}: ${i.task.title}. Stop calling tools and summarize when it is done or you are blocked.`,
  );

  const slot6Text = canonicalizePrefixText(
    clampSlot(slot6Parts.join('\n\n'), SLOT_CHAR_BUDGETS.cycleAnchor),
    i.repoRoot,
  );

  // --- SLOT 7: LIVING STATE FRAME SEED (first.content[1]) ---
  const slot7Parts: string[] = [];
  if (includeProgress) slot7Parts.push(rawProgress);
  if (!i.memory && i.evidence.length) {
    slot7Parts.push(`# Evidence from earlier attempts\n\n${i.evidence.join('\n\n')}`);
  }
  if (i.runningContext?.trim()) {
    slot7Parts.push(
      `# Your running context for ${i.task.id} (where the work stands; keep adding with running_context)\n\n${i.runningContext.trim()}`,
    );
  }

  const allParts = [slot6Text];
  if (slot7Parts.length > 0) {
    allParts.push(
      canonicalizePrefixText(
        clampSlot(slot7Parts.join('\n\n'), SLOT_CHAR_BUDGETS.initialLsf),
        i.repoRoot,
      ),
    );
  }
  const firstContent: Message['content'] = [{ type: 'text', text: allParts.join('\n\n') }];
  const canonicalTools = canonicalizeTools(i.tools, i.repoRoot);
  const prefixHash = computePrefixHash(canonicalTools, system, slot6Text);

  return {
    system,
    first: { role: 'user', content: firstContent },
    tools: canonicalTools,
    labels: blocks.map((b) => b.label),
    prefixHash,
  };
}

export type ToolChoiceMode = 'auto' | 'none' | 'required';

export interface TurnRequestOptions {
  /**
   * Lock toolChoice to 'none' on terminal synthesis turns so Slot 0 (`tools`) stays in the
   * request and preserves 100% of the provider KV-cache prefix.
   */
  toolChoice?: ToolChoiceMode | CompletionRequest['toolChoice'];
  /**
   * Optional Slot 11 ephemeral directive appended as a trailing user block without mutating
   * the cached message array.
   */
  terminalDirective?: string;
}

function normalizeToolChoice(
  choice: TurnRequestOptions['toolChoice'],
): CompletionRequest['toolChoice'] {
  if (!choice) return undefined;
  if (typeof choice === 'object') return choice;
  if (choice === 'none') return { type: 'none' };
  if (choice === 'auto') return { type: 'auto' };
  return undefined;
}

/**
 * Request for the next turn: first message (Slots 6–7) and the latest message (Slot 10) carry
 * cache breakpoints. Supports OpenCode/SWE-agent terminal prefix locking via `options`.
 */
export function turnRequest(
  ctx: { system: SystemBlock[]; tools: ToolSpec[] },
  messages: Message[],
  model: string,
  maxTokens: number,
  cacheKey?: string,
  options?: TurnRequestOptions,
): Omit<CompletionRequest, 'signal'> {
  const directive = options?.terminalDirective?.trim();
  const effectiveMessages: Message[] = directive
    ? [
        ...messages,
        {
          role: 'user',
          content: [{ type: 'text', text: directive }],
        },
      ]
    : messages;

  // Breakpoint stays on the last pre-directive message (Slot 10) so the warm prefix is hit.
  const cachedLast = Math.max(0, messages.length - 1);
  const breakpoints = cachedLast > 0 ? [0, cachedLast] : [0];
  const mappedToolChoice = normalizeToolChoice(options?.toolChoice);

  return {
    model,
    system: ctx.system,
    // Slot 0 (`tools`) is ALWAYS sent even when toolChoice === 'none' to prevent cold-cache misses.
    tools: ctx.tools,
    messages: effectiveMessages,
    maxTokens,
    messageBreakpoints: breakpoints,
    ...(cacheKey ? { promptCacheKey: cacheKey } : {}),
    ...(mappedToolChoice ? { toolChoice: mappedToolChoice } : {}),
  };
}

/**
 * Convenience builder for the terminal synthesis turn (Slot 11). Locks `toolChoice: 'none'`
 * while keeping `ctx.tools` intact so the terminal summary hits 100% warm KV-cache.
 */
export function terminalTurnRequest(
  ctx: { system: SystemBlock[]; tools: ToolSpec[] },
  messages: Message[],
  model: string,
  maxTokens: number,
  cacheKey?: string,
  reason = 'Cycle step or token ceiling reached. Synthesize final status, changes made, and exact next step without calling tools.',
): Omit<CompletionRequest, 'signal'> {
  return turnRequest(ctx, messages, model, maxTokens, cacheKey, {
    toolChoice: 'none',
    terminalDirective: `[harness:terminal_synthesis] ${reason}`,
  });
}
