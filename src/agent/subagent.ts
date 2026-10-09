import type { Run } from '../core/run.js';
import type { ResolvedModel } from '../providers/pricing.js';
import { readOnlyTools, toolSpec } from '../tools/registry.js';
import type { HelperCard, SubagentKind, Tool, ToolContext } from '../tools/types.js';
import { runAgentLoop, type LoopDeps } from './loop.js';

/** The summary handed back to the parent is capped at about 1k tokens. */
const ANSWER_MAX_CHARS = 4_000;

const BRIEF: Record<SubagentKind, string> = {
  explore: 'Find the relevant code and explain how it works, with file paths and line numbers.',
  research:
    'Find authoritative information (docs, the web, the codebase) and cite where it came from.',
  review: 'Critique the change or design: correctness, risk, missing cases. Be specific and brief.',
};

const SYSTEM = `You are a read-only helper for a coding agent. You cannot edit files.
Use the tools to answer the question, then reply with a summary under 600 words: findings first,
then file paths and the evidence behind them. Say plainly what you could not determine.`;

/** Tools a helper may never have: they write, or would let it start more helpers. */
const DENIED = new Set([
  'task',
  'agent',
  'remember',
  'write_plan',
  'write_intent',
  'integrations_search',
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

/**
 * What a helper needs from whoever starts it: a long run or a chat session. The loop pieces are
 * the parent's, so spend, pausing and stopping all count against the parent.
 */
export interface HelperEnv {
  tools: () => Promise<readonly Tool[]>;
  models: (kind: SubagentKind) => Promise<readonly ResolvedModel[]>;
  maxTokens: number;
  limits: { tokens: number; turns: number };
  loop: Omit<LoopDeps, 'models' | 'tools' | 'toolCtx' | 'budget' | 'maxTokens'> & {
    budget: LoopDeps['budget'];
  };
}

/**
 * A child agent with its own fresh context and token cap. Returns its final answer only, so
 * the parent pays for the summary, not the exploration.
 */
export function helperRunner(
  env: HelperEnv,
  parent: ToolContext,
): (description: string, kind: SubagentKind, card?: HelperCard) => Promise<string> {
  let n = 0;
  return async (description, kind, card) => {
    const id = ++n;
    const tools = cardTools(
      (await env.tools()).filter((t) => !DENIED.has(t.name)),
      card,
    );
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
    const result = await runAgentLoop(
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
        models: [...(await env.models(kind))],
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
    env.loop.events.emit('subagent.finish', {
      id,
      end: result.end,
      turns: result.turns,
      usd: result.usd,
    });
    const answer = result.finalText.trim();
    const capped =
      answer.length > ANSWER_MAX_CHARS ? `${answer.slice(0, ANSWER_MAX_CHARS)}…` : answer;
    if (result.end === 'done') return capped || '(the helper found nothing to report)';
    return `${capped}\n\n(helper stopped early: ${result.end})`.trim();
  };
}

/** Helpers for a long run: its router, budget and spend. */
export function subagentRunner(
  run: Run,
  parent: ToolContext,
): (description: string, kind: SubagentKind, card?: HelperCard) => Promise<string> {
  const cfg = run.config.context;
  return helperRunner(
    {
      tools: () => readOnlyTools(run.config, { repoRoot: run.worktree, env: run.deps.env }),
      models: async (kind) =>
        (
          await run.router.pick({
            action: 'read-explore',
            needs: { tools: true },
            facts: { subagent: kind },
          })
        ).chain,
      maxTokens: Math.min(run.config.providers.anthropic.max_tokens, 4_096),
      limits: { tokens: cfg.subagent_max_tokens, turns: cfg.subagent_max_turns },
      loop: {
        provider: run.deps.provider,
        providerBlocked: (p) => run.providerBlocked(p),
        modelExhausted: (r) => run.modelExhausted(r),
        markExhausted: (r) => {
          run.markExhausted(r);
        },
        coolProvider: (p, ms) => {
          run.coolProvider(p, ms);
        },
        budget: run.config.budget,
        clock: run.clock,
        events: run.events,
        spentUsd: () => run.state.spend.usd,
        spentTodayUsd: () => run.spentToday(),
        onUsage: (u, usd, model, provider) => run.addSpend(u, usd, model, 'subagent', provider),
        control: () => run.control(),
        signal: run.abort.signal,
      },
    },
    parent,
  );
}
