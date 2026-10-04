import type { OmnexxConfig } from '../config/schema.js';
import type { Clock } from '../core/clock.js';
import type { EventLog } from '../core/events.js';
import { estimateTokens } from '../core/tokens.js';
import { preflight, type BudgetStop } from '../guard/budget.js';
import { costUsd, type ResolvedModel } from '../providers/pricing.js';
import { StopRequested, withRetry } from '../providers/retry.js';
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
import { turnRequest } from './context.js';

export type ControlSignal = 'continue' | 'pause' | 'stop' | 'stop-now';

export type LoopEnd = 'done' | 'stop' | 'stop-now' | BudgetStop | 'refusal';

export interface LoopResult {
  end: LoopEnd;
  turns: number;
  finalText: string;
  usage: Usage;
  usd: number;
  messages: Message[];
}

export interface LoopDeps {
  provider: Provider;
  model: ResolvedModel;
  tools: readonly Tool[];
  toolCtx: ToolContext;
  budget: OmnexxConfig['budget'];
  maxTokens: number;
  clock: Clock;
  events: EventLog;
  /** Spend so far across the run, before this call. */
  spentUsd: () => number;
  /** Persist spend after every call so a crash never forgets money already spent. */
  onUsage: (usage: Usage, usd: number, model: string) => Promise<void>;
  control: () => Promise<ControlSignal>;
  /** How often to re-check control.json while paused. */
  pausePollMs?: number;
  /** Notifies the supervisor's heartbeat that we're paused or running. */
  onPauseChange?: (paused: boolean) => void;
  retry?: { baseDelayMs?: number; maxDelayMs?: number; onOutage?: (ms: number) => void };
  signal?: AbortSignal;
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
  ctx: { system: SystemBlock[]; first: Message; tools: ToolSpec[] },
  deps: LoopDeps,
): Promise<LoopResult> {
  const messages: Message[] = [ctx.first];
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

    const req = turnRequest(ctx, messages, deps.model.id, deps.maxTokens);
    const estimate = estimateTokens(JSON.stringify([req.system, req.tools, req.messages]));
    const pf = preflight(deps.budget, {
      spentUsd: deps.spentUsd(),
      cycle: { turns, tokens: cycleTokens },
      estimatedInputTokens: estimate,
      maxOutputTokens: deps.maxTokens,
      price: deps.model.price,
    });
    if (!pf.ok) {
      deps.events.emit('budget.preflight_stop', { stop: pf.stop, detail: pf.detail, turn: turns });
      return end(pf.stop);
    }

    let res: CompletionResponse;
    try {
      res = await withRetry(
        () => deps.provider.complete({ ...req, ...(deps.signal ? { signal: deps.signal } : {}) }),
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
      throw err;
    }
    turns++;
    const cost = costUsd(res.usage, deps.model.price);
    usd += cost;
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += res.usage[k];
    cycleTokens += totalInput(res.usage) + res.usage.output;
    await deps.onUsage(res.usage, cost, res.model);
    const input = totalInput(res.usage);
    deps.events.emit('turn', {
      turn: turns,
      model: res.model,
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

    const results: ContentBlock[] = [];
    for (const call of calls) {
      const tool = byName.get(call.name);
      let content: string;
      let isError: boolean;
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
      });
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content,
        ...(isError ? { isError: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }
}
