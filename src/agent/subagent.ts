import { resolveModel } from '../providers/pricing.js';
import { orderForStrategy, strategyFor, type Strategy } from '../config/routing.js';
import type { Run } from '../core/run.js';
import type { ResolvedModel } from '../providers/pricing.js';
import { readOnlyTools, toolSpec } from '../tools/registry.js';
import type { HelperCard, SubagentKind, Tool, ToolContext } from '../tools/types.js';
import { runAgentLoop, type LoopDeps } from './loop.js';

/** Token budget for the structured result handed back to the parent (acceptance: <=500 tokens). */
export const RESULT_MAX_CHARS = 1_500;

const BRIEF: Record<SubagentKind, string> = {
  explore:
    'Find the relevant code and explain how it works succinctly, with exact file paths and line spans.',
  research:
    'Find authoritative information (docs, web, codebase), verify facts, and cite precise sources.',
  review:
    'Critique the change or design: correctness, security risk, missing edge cases. Be specific and dense.',
};

const SYSTEM = `You are a read-only helper for a coding agent. You cannot edit files or run commands.
Thoroughly explore the codebase and documentation using your read-only tools to gather evidence.
Once finished, synthesize your findings into a dense, compact executive summary (under 250 words):
1. Key Answer/Finding: direct, actionable takeaway.
2. Exact Locations: file paths with line numbers (e.g. src/auth.ts:42).
3. Confidence: 0-100% based on evidence found.
Keep the final reply extremely concise so the orchestrator's primary context window remains lean.`;

/** Tools a helper may never have: they write, run commands, or would let it start more helpers. */
export const DENIED = new Set([
  'task',
  // A helper's checklist would replace the parent's on screen.
  'todo',
  'agent',
  'remember',
  'write_plan',
  'write_intent',
  'integrations_search',
  // Mutating and command execution tools (sandboxed to read-only tools)
  'bash',
  'write_file',
  'str_replace',
  'apply_patch',
  'patch',
  'write',
  'edit',
]);

/** Claude Code's tool names, as agent cards list them, to omnexx's read-only tools. */
const CARD_TOOLS: Record<string, readonly string[]> = {
  read: ['read', 'outline'],
  grep: ['search'],
  glob: ['search'],
  ls: ['search'],
  search: ['search'],
  bash: ['bash', 'read_log'],
  webfetch: ['web_fetch'],
  websearch: ['web_search'],
  skill: ['skill'],
};

/** The helper's tools for a card: what it asked for (mapped), always within the read-only set. */
export function cardTools(tools: readonly Tool[], card: HelperCard | undefined): readonly Tool[] {
  if (!card?.tools.length) return tools;
  const wanted = new Set([
    'read',
    ...card.tools.flatMap((t) => CARD_TOOLS[t.toLowerCase()] ?? [t]),
  ]);
  return tools.filter((t) => wanted.has(t.name));
}

/** Resolves and strictly sanitizes tools for a subagent, stripping denied and mutating tools. */
export function safeSubagentTools(
  tools: readonly Tool[],
  card: HelperCard | undefined,
): readonly Tool[] {
  return cardTools(tools, card).filter((t) => !DENIED.has(t.name));
}

/**
 * What a helper needs from whoever starts it: a long run or a chat session. The loop pieces are
 * the parent's, so spend, pausing and stopping all count against the parent.
 */
export interface HelperEnv {
  tools: () => Promise<readonly Tool[]>;
  models: (kind: SubagentKind) => Promise<readonly ResolvedModel[]>;
  /** How each helper orders its models (models.routing.helpers); priority when unset. */
  strategy?: Strategy;
  maxTokens: number;
  limits: { tokens: number; turns: number };
  loop: Omit<LoopDeps, 'models' | 'tools' | 'toolCtx' | 'budget' | 'maxTokens'> & {
    budget: LoopDeps['budget'];
  };
}

/**
 * Structured, token-bounded result a subagent hands back to its parent, so the parent only
 * pays for the summary — never the full transcript (which is stored as an artifact event).
 */
export interface SubagentResult {
  /** The key findings, truncated to stay within {@link RESULT_MAX_CHARS}. */
  findings: string;
  /** File paths the findings rely on (at most 8). */
  files: readonly string[];
  /** Confidence in the findings, 0..1. */
  confidence: number;
}

export function formatSubagentResult(result: SubagentResult): string {
  const parts = [
    result.findings.trim(),
    result.files.length ? `Key Files:\n${result.files.map((f) => `- ${f}`).join('\n')}` : '',
    `Confidence: ${String(Math.round(result.confidence * 100))}%`,
  ].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * A child agent with its own fresh context and token cap. Returns a bounded structured result, so
 * the parent pays for the summary, not the exploration. The full transcript is emitted as a
 * `subagent.artifact` event and never injected into the parent context.
 */
export function helperRunner(
  env: HelperEnv,
  parent: ToolContext,
): (description: string, kind: SubagentKind, card?: HelperCard) => Promise<SubagentResult> {
  let n = 0;
  /** Helpers running per provider, for least-busy routing. */
  const busy = new Map<string, number>();
  return async (description, kind, card) => {
    const id = ++n;
    const tools = safeSubagentTools(await env.tools(), card);
    const ctx: ToolContext = {
      ...parent,
      edited: new Set(),
      reads: new Map(),
      nextCommandId: () => `${parent.nextCommandId()}-t${id}`,
    };
    // No grandchildren: a helper's task tool reports it isn't available.
    delete ctx.subagent;
    env.loop.events.emit('subagent.start', {
      id,
      kind,
      ...(card ? { agent: card.name } : {}),
      description: description.slice(0, 200),
    });
    const system = card
      ? `${SYSTEM}\n\n# You are the "${card.name}" agent\n\n${card.prompt}`
      : SYSTEM;
    const chain = orderForStrategy(await env.models(kind), env.strategy ?? 'fallback', { busy });
    const lead = chain[0]?.provider;
    if (lead) busy.set(lead, (busy.get(lead) ?? 0) + 1);
    let result: Awaited<ReturnType<typeof runAgentLoop>>;
    try {
      result = await runAgentLoop(
        {
          system: [{ text: system }],
          first: {
            role: 'user',
            content: [
              { type: 'text', text: card ? description : `${BRIEF[kind]}\n\n${description}` },
            ],
          },
          tools: tools.map(toolSpec),
        },
        {
          ...env.loop,
          purpose: 'subagent',
          models: chain,
          // least-busy only picks the lead; per call the chain behaves like fallback.
          strategy:
            env.strategy === 'random' || env.strategy === 'priority' ? env.strategy : 'fallback',
          tools,
          toolCtx: ctx,
          budget: {
            ...env.loop.budget,
            max_tokens_per_cycle: env.limits.tokens,
            max_turns_per_cycle: env.limits.turns,
          },
          maxTokens: env.maxTokens,
        },
      );
    } finally {
      // Free the provider's slot even when the helper fails, or it would look busy for ever.
      if (lead) busy.set(lead, Math.max(0, (busy.get(lead) ?? 1) - 1));
    }
    env.loop.events.emit('subagent.finish', {
      id,
      end: result.end,
      turns: result.turns,
      usd: result.usd,
    });

    // Emit full transcript as an artifact event (not injected into parent context).
    env.loop.events.emit('subagent.artifact', {
      id,
      kind,
      ...(card ? { agent: card.name } : {}),
      description: description.slice(0, 200),
      turns: result.turns,
      usd: result.usd,
      messages: result.messages,
      usage: result.usage,
    });

    // Build the bounded structured result.
    const answer = result.finalText.trim();
    const findings =
      answer.length > RESULT_MAX_CHARS ? `${answer.slice(0, RESULT_MAX_CHARS - 1)}…` : answer;
    const seenFiles = new Set<string>();
    const files: string[] = [];
    const filePattern =
      /(?:^|[\s(`"'])((?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cpp|c|h|hpp|json|yaml|yml|toml|md|txt))(?::(\d+))?/g;
    let m: RegExpExecArray | null;
    while ((m = filePattern.exec(answer)) !== null) {
      const path = m[1];
      const line = m[2];
      if (path && !path.startsWith('http') && path.length > 2) {
        const ref = line ? `${path}:${line}` : path;
        if (!seenFiles.has(ref)) {
          seenFiles.add(ref);
          files.push(ref);
          if (files.length >= 8) break;
        }
      }
    }
    let confidence = 0.7;
    const confMatch =
      /confidence[:\s]+(0?\.\d+|1\.0?)/i.exec(answer) ?? /confidence[:\s]+(\d+)%/i.exec(answer);
    if (confMatch?.[1]) {
      const val = parseFloat(confMatch[1]);
      confidence =
        confMatch[1].includes('%') || val > 1
          ? Math.min(1, val / 100)
          : Math.min(1, Math.max(0, val));
    }

    return { findings, files, confidence };
  };
}

const chainOf = (c: string | readonly string[]): readonly string[] =>
  typeof c === 'string' ? [c] : c;

/** Helpers for a long run: its router (or models.helpers), budget and spend. */
export function subagentRunner(
  run: Run,
  parent: ToolContext,
): (description: string, kind: SubagentKind, card?: HelperCard) => Promise<SubagentResult> {
  const cfg = run.config.context;
  return helperRunner(
    {
      tools: () => readOnlyTools(run.config, { repoRoot: run.worktree, env: run.deps.env }),
      models: async (kind) =>
        run.config.models.helpers
          ? chainOf(run.config.models.helpers).map((ref) => resolveModel(ref, run.config))
          : (
              await run.router.pick({
                action: 'read-explore',
                needs: { tools: true },
                facts: { subagent: kind },
              })
            ).chain,
      strategy: strategyFor(run.config.models, 'helpers'),
      maxTokens: Math.min(run.config.providers.anthropic.max_tokens, 4_096),
      limits: { tokens: cfg.subagent_max_tokens, turns: cfg.subagent_max_turns },
      loop: {
        provider: run.deps.provider,
        providerBlocked: (p) => run.providerBlocked(p),
        modelExhausted: (r) => run.modelExhausted(r),
        markExhausted: (r) => {
          run.markExhausted(r);
        },
        markRateLimited: (r, ms) => {
          run.markRateLimited(r, ms);
        },
        coolProvider: (p, ms) => {
          run.coolProvider(p, ms);
        },
        budget: run.config.budget,
        clock: run.clock,
        events: run.events,
        taskId: () => run.state.taskId,
        cycle: () => run.state.cycle,
        taskBudget: run.taskBudget,
        spentUsd: () => run.state.spend.usd,
        spentTodayUsd: () => run.spentToday(),
        onUsage: (u, usd, model, provider, meta) =>
          run.addSpend(u, usd, model, 'subagent', provider, meta),
        control: () => run.control(),
        signal: run.abort.signal,
      },
    },
    parent,
  );
}
