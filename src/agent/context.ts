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
 * Deterministically sort ToolSpecs by name so Slot 0 never invalidates the provider KV-cache
 * due to object registration order changes.
 */
function canonicalizeTools(tools: readonly ToolSpec[]): ToolSpec[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
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
    { label: 'system', text: clampSlot(i.systemPrompt.trim(), SLOT_CHAR_BUDGETS.core) },
  ];

  // Slot 2: Repository Codemap
  if (keep('codemap', i.codemap)) {
    blocks.push({ label: 'codemap', text: clampSlot(i.codemap.trim(), SLOT_CHAR_BUDGETS.codemap) });
  }

  // Slot 3: Goal + Planner Intent
  const intent = keep('intent', i.intent) ? `\n\n${(i.intent ?? '').trim()}` : '';
  blocks.push({
    label: 'goal',
    text: clampSlot(`# Goal\n\n${i.goal.trim()}${intent}`, SLOT_CHAR_BUDGETS.goal),
  });

  // Slot 4: Runtime Settings (brief) & Verified Repo Facts
  if (i.brief?.trim()) {
    blocks.push({ label: 'settings', text: clampSlot(i.brief.trim(), SLOT_CHAR_BUDGETS.facts) });
  }
  if (i.facts?.trim()) {
    blocks.push({ label: 'facts', text: clampSlot(i.facts.trim(), SLOT_CHAR_BUDGETS.facts) });
  }

  // Slot 5: Cross-Cycle Lessons (notes.md)
  if (keep('lessons', i.notes)) {
    blocks.push({
      label: 'notes',
      text: clampSlot(`# Lessons (notes.md)\n\n${i.notes.trim()}`, SLOT_CHAR_BUDGETS.lessons),
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

  const slot6Text = clampSlot(slot6Parts.join('\n\n'), SLOT_CHAR_BUDGETS.cycleAnchor);

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
      clampSlot(
        slot7Parts.join('\n\n'),
        SLOT_CHAR_BUDGETS.initialLsf,
      )
    );
  }
  const firstContent: Message['content'] = [{ type: 'text', text: allParts.join('\n\n') }];

  return {
    system,
    first: { role: 'user', content: firstContent },
    tools: canonicalizeTools(i.tools),
    labels: blocks.map((b) => b.label),
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

function normalizeToolChoice(choice: TurnRequestOptions['toolChoice']): CompletionRequest['toolChoice'] {
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
