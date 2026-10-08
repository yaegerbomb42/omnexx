import type { Run } from '../core/run.js';
import { readOnlyTools, toolSpec } from '../tools/registry.js';
import type { SubagentKind, ToolContext } from '../tools/types.js';
import { runAgentLoop } from './loop.js';

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
const DENIED = new Set(['task', 'remember', 'write_plan', 'write_intent']);

/**
 * A child agent with its own fresh context and token cap. Returns its final answer only, so
 * the parent pays for the summary, not the exploration. Spend counts against the run.
 */
export function subagentRunner(
  run: Run,
  parent: ToolContext,
): (description: string, kind: SubagentKind) => Promise<string> {
  let n = 0;
  return async (description, kind) => {
    const id = ++n;
    const tools = (await readOnlyTools(run.config)).filter((t) => !DENIED.has(t.name));
    const ctx: ToolContext = {
      ...parent,
      edited: new Set(),
      reads: new Map(),
      nextCommandId: () => `${parent.nextCommandId()}-t${id}`,
    };
    // No grandchildren: a helper's task tool reports it isn't available.
    delete ctx.subagent;
    const cfg = run.config.context;
    run.events.emit('subagent.start', { id, kind, description: description.slice(0, 200) });
    const result = await runAgentLoop(
      {
        system: [{ text: SYSTEM }],
        first: {
          role: 'user',
          content: [{ type: 'text', text: `${BRIEF[kind]}\n\n${description}` }],
        },
        tools: tools.map(toolSpec),
      },
      {
        provider: run.deps.provider,
        models: (
          await run.router.pick({
            action: 'read-explore',
            needs: { tools: true },
            facts: { subagent: kind },
          })
        ).chain,
        providerBlocked: (p) => run.providerBlocked(p),
        modelExhausted: (r) => run.modelExhausted(r),
        markExhausted: (r) => {
          run.markExhausted(r);
        },
        coolProvider: (p, ms) => {
          run.coolProvider(p, ms);
        },
        tools,
        toolCtx: ctx,
        budget: {
          ...run.config.budget,
          max_tokens_per_cycle: cfg.subagent_max_tokens,
          max_turns_per_cycle: cfg.subagent_max_turns,
        },
        maxTokens: Math.min(run.config.providers.anthropic.max_tokens, 4_096),
        clock: run.clock,
        events: run.events,
        spentUsd: () => run.state.spend.usd,
        spentTodayUsd: () => run.spentToday(),
        onUsage: (u, usd, model, provider) => run.addSpend(u, usd, model, 'subagent', provider),
        control: () => run.control(),
        signal: run.abort.signal,
      },
    );
    run.events.emit('subagent.finish', {
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
