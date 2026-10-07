import type { OmnexxConfig } from '../config/schema.js';
import type { Clock } from '../core/clock.js';
import type { EventLog } from '../core/events.js';
import { estimateTokens } from '../core/tokens.js';
import { preflight, type BudgetStop } from '../guard/budget.js';
import { costUsd, type ResolvedModel } from '../providers/pricing.js';
import { StopRequested, withRetry } from '../providers/retry.js';
import { shouldFailover } from '../providers/router.js';
import { ProviderError } from '../errors.js';
import {
  totalInput,
  type CompletionResponse,
  type ContentBlock,
  type Message,
  type Provider,
  type SystemBlock,
  type ToolSpec,
  type Usage,
} from '../providers/types.js';
import type { Tool, ToolContext } from '../tools/types.js';
import { manageContext, type CompactionSettings, type Summarize } from './compaction.js';
import { turnRequest } from './context.js';
import type { InCycleWatch, StuckFinding } from '../guard/stuck.js';

/** Thrown inside the retry loop when a pre-flight check refuses the call; ends the cycle, never retried. */
class BudgetStopSignal extends Error {
  constructor(
    readonly stop: BudgetStop,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export type ControlSignal = 'continue' | 'pause' | 'stop' | 'stop-now';

export type LoopEnd = 'done' | 'stop' | 'stop-now' | BudgetStop | 'refusal' | 'stuck';

export interface LoopResult {
  end: LoopEnd;
  turns: number;
  finalText: string;
  usage: Usage;
  usd: number;
  messages: Message[];
  /** Set when the loop ended as `stuck`. */
  stuck?: StuckFinding;
}

export interface LoopDeps {
  provider: Provider;
  /** The role's failover chain: tried in order, skipping providers that are blocked. */
  models: readonly ResolvedModel[];
  /** Why a provider can't take a call now (its own caps, cooling after a failure), or undefined. */
  providerBlocked?: (provider: string) => string | undefined;
  /** Skip this provider for a while after it failed. */
  coolProvider?: (provider: string, ms: number) => void;
  tools: readonly Tool[];
  toolCtx: ToolContext;
  budget: OmnexxConfig['budget'];
  maxTokens: number;
  clock: Clock;
  events: EventLog;
  /** Spend so far across the run, before this call. */
  spentUsd: () => number;
  /** Spend in the rolling 24 h window, for the daily cap. */
  spentTodayUsd?: () => number;
  /** Persist spend after every call so a crash never forgets money already spent. */
  onUsage: (usage: Usage, usd: number, model: string, provider: string) => Promise<void>;
  control: () => Promise<ControlSignal>;
  /** How often to re-check control.json while paused. */
  pausePollMs?: number;
  /** Notifies the supervisor's heartbeat that we're paused or running. */
  onPauseChange?: (paused: boolean) => void;
  retry?: { baseDelayMs?: number; maxDelayMs?: number; onOutage?: (ms: number) => void };
  signal?: AbortSignal;
  /** In-cycle context control; off when unset. */
  compaction?: { settings: CompactionSettings; summarize?: Summarize };
  /** In-cycle stuck detection; off when unset. */
  watch?: InCycleWatch;
  /** How many `task` calls from one turn run at once (default 1). */
  parallelTasks?: number;
}

function summarizeInput(input: unknown): string {
  const s = JSON.stringify(input);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * The agent loop for one cycle: turn → tools → turn … until the model stops calling tools, a
 * cap would be crossed (checked before every call), or a control request arrives. Pause blocks
 * here at a turn boundary; no tokens are spent while paused or while a command runs.
 */
export async function runAgentLoop(
  ctx: {
    system: SystemBlock[];
    first: Message;
    tools: ToolSpec[];
    /** Earlier turns of an interactive chat, sent before `first`. */
    history?: readonly Message[];
  },
  deps: LoopDeps,
): Promise<LoopResult> {
  let messages: Message[] = [...(ctx.history ?? []), ctx.first];
  const usage: Usage = { uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  let usd = 0;
  let turns = 0;
  let cycleTokens = 0;
  let finalText = '';
  const byName = new Map(deps.tools.map((t) => [t.name, t]));
  const end = (e: LoopEnd): LoopResult => ({ end: e, turns, finalText, usage, usd, messages });

  for (;;) {
    let signal = await deps.control();
    if (signal === 'pause') {
      deps.events.emit('control.paused', { turn: turns });
      deps.onPauseChange?.(true);
      while (signal === 'pause') {
        await deps.clock.sleep(deps.pausePollMs ?? 1_000);
        signal = await deps.control();
      }
      deps.onPauseChange?.(false);
      deps.events.emit('control.resumed', { turn: turns });
    }
    if (signal === 'stop' || signal === 'stop-now') return end(signal);

    if (deps.compaction && turns > 0) {
      messages = await manageContext(
        messages,
        ctx.first,
        deps.compaction.settings,
        deps.compaction.summarize,
        ({ kind, ...rest }) => {
          // Earlier read results are gone from the context now; let `read` return them again.
          if (kind === 'cleared' || kind === 'compacted') deps.toolCtx.reads?.clear();
          deps.events.emit(`context.${kind}`, { turn: turns, ...rest });
        },
      );
    }

    let chosen: ResolvedModel | undefined;
    let res: CompletionResponse;
    const callStart = deps.clock.now();
    try {
      res = await withRetry(
        async () => {
          const skipped: string[] = [];
          let onlyBudget = true;
          for (const m of deps.models) {
            const blocked = deps.providerBlocked?.(m.provider);
            if (blocked) {
              if (!blocked.includes('max_usd')) onlyBudget = false;
              skipped.push(`${m.provider}: ${blocked}`);
              continue;
            }
            const req = turnRequest(ctx, messages, m.id, deps.maxTokens);
            const estimate = estimateTokens(JSON.stringify([req.system, req.tools, req.messages]));
            const pf = preflight(deps.budget, {
              spentUsd: deps.spentUsd(),
              ...(deps.spentTodayUsd ? { spentTodayUsd: deps.spentTodayUsd() } : {}),
              cycle: { turns, tokens: cycleTokens },
              estimatedInputTokens: estimate,
              maxOutputTokens: deps.maxTokens,
              price: m.price,
            });
            if (!pf.ok) throw new BudgetStopSignal(pf.stop, pf.detail);
            try {
              const r = await deps.provider.complete({
                ...req,
                route: m.provider,
                ...(deps.signal ? { signal: deps.signal } : {}),
              });
              chosen = m;
              return r;
            } catch (err) {
              if (!shouldFailover(err)) throw err;
              onlyBudget = false;
              // Transient trouble: retry this provider soon. Key, quota or model problems: much later.
              deps.coolProvider?.(m.provider, err.retryable ? 60_000 : 30 * 60_000);
              deps.events.emit('provider.failover', {
                provider: m.provider,
                model: m.id,
                error: err.message,
                status: err.status,
              });
              skipped.push(`${m.provider}: ${err.message}`);
            }
          }
          if (skipped.length && onlyBudget)
            throw new BudgetStopSignal(
              'max_usd',
              `every provider in the chain is over its own cap (${skipped.join('; ')})`,
            );
          throw new ProviderError(
            `no provider in the chain could take the call: ${skipped.join('; ')}`,
            { retryable: true },
          );
        },
        {
          clock: deps.clock,
          shouldStop: async () => {
            const c = await deps.control();
            return c === 'stop' || c === 'stop-now';
          },
          onRetry: (i) =>
            deps.events.emit('provider.retry', {
              attempt: i.attempt,
              delayMs: i.delayMs,
              error: i.error,
              outageMs: i.outageMs,
            }),
          onOutage: (ms) => {
            deps.events.emit('provider.outage', { outageMs: ms });
            deps.retry?.onOutage?.(ms);
          },
          onRecovered: (ms, attempts) =>
            deps.events.emit('provider.recovered', { outageMs: ms, attempts }),
          ...(deps.retry?.baseDelayMs !== undefined ? { baseDelayMs: deps.retry.baseDelayMs } : {}),
          ...(deps.retry?.maxDelayMs !== undefined ? { maxDelayMs: deps.retry.maxDelayMs } : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        },
      );
    } catch (err) {
      if (err instanceof StopRequested) return end('stop');
      if (err instanceof BudgetStopSignal) {
        deps.events.emit('budget.preflight_stop', {
          stop: err.stop,
          detail: err.detail,
          turn: turns,
        });
        return end(err.stop);
      }
      throw err;
    }
    const model = chosen ?? deps.models[0];
    if (!model) throw new ProviderError('empty model chain', { retryable: false });
    turns++;
    const cost = costUsd(res.usage, model.price);
    usd += cost;
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += res.usage[k];
    cycleTokens += totalInput(res.usage) + res.usage.output;
    await deps.onUsage(res.usage, cost, res.model, model.provider);
    const input = totalInput(res.usage);
    deps.events.emit('turn', {
      turn: turns,
      model: res.model,
      provider: model.provider,
      ms: deps.clock.now() - callStart,
      stopReason: res.stopReason,
      tokens: {
        uncached: res.usage.uncached,
        cacheWrite: res.usage.cacheWrite5m + res.usage.cacheWrite1h,
        cacheRead: res.usage.cacheRead,
        output: res.usage.output,
      },
      cacheReadShare: input ? res.usage.cacheRead / input : 0,
      usd: cost,
    });

    messages.push({ role: 'assistant', content: res.content });
    const text = res.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) finalText = text;
    const calls = res.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (res.stopReason === 'refusal') return end('refusal');
    if (calls.length === 0) return end('done');

    const runCall = async (call: (typeof calls)[number]): Promise<ContentBlock> => {
      const tool = byName.get(call.name);
      let content: string;
      let isError: boolean;
      const toolStart = deps.clock.now();
      if (!tool) {
        content = `unknown tool ${call.name}`;
        isError = true;
      } else {
        const parsed = tool.schema.safeParse(call.input);
        if (!parsed.success) {
          content = `invalid input for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
          isError = true;
        } else {
          const out = await tool.run(parsed.data, deps.toolCtx);
          content = out.content;
          isError = out.isError === true;
        }
      }
      content = deps.toolCtx.redactor.text(content);
      deps.events.emit('tool.call', {
        tool: call.name,
        input: summarizeInput(call.input),
        isError,
        bytes: content.length,
        ms: deps.clock.now() - toolStart,
      });
      return {
        type: 'tool_result',
        toolUseId: call.id,
        content,
        ...(isError ? { isError: true } : {}),
      };
    };
    const results: ContentBlock[] = [];
    // A turn of only `task` calls fans out: read-only helpers can't conflict with each other.
    const parallel = calls.every((c) => c.name === 'task') ? (deps.parallelTasks ?? 1) : 1;
    for (let i = 0; i < calls.length; i += parallel)
      results.push(...(await Promise.all(calls.slice(i, i + parallel).map(runCall))));
    messages.push({ role: 'user', content: results });

    const finding = deps.watch?.afterTurn(turns, cycleTokens, calls);
    if (finding) {
      deps.events.emit('stuck.in_cycle', {
        signal: finding.signal,
        detail: finding.detail,
        turn: turns,
      });
      return { ...end('stuck'), stuck: finding };
    }
  }
}
