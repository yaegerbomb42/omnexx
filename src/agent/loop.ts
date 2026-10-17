import {
  callOrder,
  RATE_LIMITED_FOR_MS,
  skipsOutModels,
  sticksOnRateLimit,
  type Strategy,
} from '../config/routing.js';
import type { OmnexxConfig } from '../config/schema.js';
import type { Clock } from '../core/clock.js';
import type { EventLog } from '../core/events.js';
import {
  loadTokenRatios,
  observeTokenRatio,
  saveTokenRatio,
  tokenRatio,
  type TokenRatios,
} from '../core/token-calibration.js';
import { applyTokenRatio, estimateTokens } from '../core/tokens.js';
import { preflight, type BudgetStop } from '../guard/budget.js';
import { costUsd, type ResolvedModel } from '../providers/pricing.js';
import { ProvidersUnavailable, StopRequested, withRetry } from '../providers/retry.js';
import { narrateTool } from '../telemetry/narrate.js';
import { shouldFailover } from '../providers/router.js';
import { isQuotaError } from '../providers/sticky.js';
import { ProviderError } from '../errors.js';
import {
  budgetTokens,
  totalInput,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type Message,
  type Provider,
  type SystemBlock,
  type ToolSpec,
  type Usage,
} from '../providers/types.js';
import type { Tool, ToolContext } from '../tools/types.js';
import {
  contextTokens,
  manageContext,
  type CompactionSettings,
  type Summarize,
} from './compaction.js';
import { turnRequest } from './context.js';
import type { InCycleWatch, StuckFinding } from '../guard/stuck.js';
import { todoItemsOf, todoNudge, todoTool, type TodoItem } from '../tools/todo.js';

/** Thrown inside the retry loop when a pre-flight check refuses the call; ends the cycle, never retried. */
class BudgetStopSignal extends Error {
  constructor(
    readonly stop: BudgetStop,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * Tool names models invent for tools that exist under another name (DeepSeek called
 * print_tree and list_files in its first real run). They run the real tool instead of failing.
 */
const TOOL_ALIASES: Record<string, string> = {
  print_tree: 'outline',
  tree: 'outline',
  ls: 'outline',
  list_files: 'outline',
  list_dir: 'outline',
  list_directory: 'outline',
  file_tree: 'outline',
  find_files: 'outline',
  glob: 'outline',
  list: 'outline',
  grep: 'search',
  ripgrep: 'search',
  search_files: 'search',
  search_code: 'search',
  code_search: 'search',
  cat: 'read',
  read_file: 'read',
  open_file: 'read',
  view_file: 'read',
  view: 'read',
  create_file: 'write_file',
  write: 'write_file',
  edit: 'str_replace',
  edit_file: 'str_replace',
  replace: 'str_replace',
  shell: 'bash',
  run: 'bash',
  run_command: 'bash',
  execute: 'bash',
  exec: 'bash',
  terminal: 'bash',
};

/** What the model is told when it seems stuck in an interactive turn. */
/** Argument names models use for the ones our tools take. */
const ARG_SYNONYMS: Record<string, string> = {
  file_path: 'path',
  filepath: 'path',
  filename: 'path',
  file: 'path',
  dir: 'path',
  directory: 'path',
  line_start: 'start',
  start_line: 'start',
  from_line: 'start',
  line_end: 'end',
  end_line: 'end',
  to_line: 'end',
  query: 'pattern',
  regex: 'pattern',
  cmd: 'command',
  old_string: 'old_str',
  new_string: 'new_str',
  old_text: 'old_str',
  new_text: 'new_str',
  text: 'content',
};

/**
 * The input with synonyms renamed and keys the tool doesn't take dropped, or undefined when
 * nothing changed. Only for tools whose schema is a plain object.
 */
export function lenientInput(schema: unknown, input: unknown): Record<string, unknown> | undefined {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof input !== 'object' || input === null || Array.isArray(input))
    return undefined;
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [k, v] of Object.entries(input)) {
    const name: string | undefined = k in shape ? k : ARG_SYNONYMS[k];
    if (name && name in shape && !(name in out)) {
      out[name] = v;
      if (name !== k) changed = true;
    } else changed = true;
  }
  return changed ? out : undefined;
}

export function stuckNudge(detail: string): string {
  return `[harness] You seem to be going in circles (${detail}). If the request is done, stop calling tools and give your summary now. If not, say in one line what is blocking you, then take a different approach; don't repeat the same searches or commands.`;
}

export type ControlSignal = 'continue' | 'pause' | 'stop' | 'stop-now';

/** `rounds_spent`: a think-loop session used every check round without passing its checks. */
export type LoopEnd =
  'done' | 'stop' | 'stop-now' | BudgetStop | 'refusal' | 'stuck' | 'rounds_spent';

export interface LoopResult {
  end: LoopEnd;
  turns: number;
  finalText: string;
  usage: Usage;
  usd: number;
  messages: Message[];
  /** Set when the loop ended as `stuck`. */
  stuck?: StuckFinding;
  /** Why it ended, for ends that need explaining (`providers_unavailable`). */
  detail?: string;
}

export interface LoopDeps {
  provider: Provider;
  /** The role's failover chain: tried in order, skipping providers that are blocked. */
  models: readonly ResolvedModel[];
  /** Why a provider can't take a call now (its own caps, cooling after a failure), or undefined. */
  providerBlocked?: (provider: string) => string | undefined;
  /** Skip this provider for a while after it failed. */
  coolProvider?: (provider: string, ms: number) => void;
  /** Whether this provider:model is out of quota (skipped until its quota resets). */
  modelExhausted?: (ref: string) => boolean;
  /** Record that this provider:model is out of quota, so the chain moves past it. */
  markExhausted?: (ref: string) => void;
  /** Record that this provider:model is rate-limited for `ms` (fallback lists move past it). */
  markRateLimited?: (ref: string, ms: number) => void;
  /** How the chain is used per call (routing.ts): random reshuffles, priority ignores quota marks. */
  strategy?: Strategy;
  tools: readonly Tool[];
  toolCtx: ToolContext;
  budget: OmnexxConfig['budget'];
  maxTokens: number;
  clock: Clock;
  events: EventLog;
  /** Stable id for this run, sent as OpenAI's prompt_cache_key. */
  cacheKey?: string;
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
  retry?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Give up after this long with no provider able to take the call. */
    giveUpAfterMs?: number;
    onOutage?: (ms: number) => void;
  };
  signal?: AbortSignal;
  /** A model request is about to go out (for "waiting on the model" estimates). */
  onRequest?: (r: { model: string; inputTokens: number }) => void;
  /** A model request answered, after `ms`. */
  onResponse?: (r: { model: string; inputTokens: number; ms: number }) => void;
  /** In-cycle context control; off when unset. */
  compaction?: { settings: CompactionSettings; summarize?: Summarize };
  /** In-cycle stuck detection; off when unset. */
  watch?: InCycleWatch;
  /**
   * What a stuck signal does: "stop" ends the turn (unattended cycles start fresh anyway); "nudge"
   * (interactive chat) tells the model first and stops only if the same signal fires again.
   */
  watchMode?: 'stop' | 'nudge';
  /** How many `task` calls from one turn run at once (default 1). */
  parallelTasks?: number;
  /** Interactive chat: stream text and reasoning as the model writes them. */
  onDelta?: CompletionRequest['onDelta'];
  /**
   * Interactive chat: messages the person typed while the agent was working. Drained after
   * every step and added to the conversation right away, so they steer the current turn.
   */
  pendingInput?: () => string[];
  /**
   * `token-calibration.json` beside latency.json. Unset: every estimate stays at ratio 1.
   * The loop loads it once and writes the EMA after each turn that reports prompt tokens.
   */
  calibrationFile?: string;
}

/** Uncalibrated size of the prompt the provider will see, and that size scaled by the model's ratio. */
function pricedPrompt(
  ratios: TokenRatios,
  model: { provider: string; id: string },
  req: { system: unknown; tools: unknown; messages: unknown },
): { key: string; raw: number; estimate: number } {
  const raw = estimateTokens(JSON.stringify([req.system, req.tools, req.messages]));
  const key = `${model.provider}:${model.id}`;
  return { key, raw, estimate: applyTokenRatio(raw, tokenRatio(ratios, key)) };
}

/** How messages typed mid-turn reach the model. */
export const steeringText = (msgs: readonly string[]): string =>
  `The user sent ${msgs.length === 1 ? 'a message' : 'messages'} while you were working. Read ${msgs.length === 1 ? 'it' : 'them'} now and adjust:\n${msgs.map((m) => `> ${m}`).join('\n')}`;

/** Look-around tools: a turn spent on just one of these, before any edit, is a wasted round trip. */
const EXPLORE_TOOLS: ReadonlySet<string> = new Set(['read', 'outline', 'search', 'read_symbol']);

/**
 * A later turn whose cache read is under 80% of the previous prompt. The first turn has nothing
 * cached yet, so it is never a miss.
 */
export function cacheShortfall(
  turn: number,
  previousPromptTokens: number,
  cacheRead: number,
): { turn: number; expected: number; got: number } | undefined {
  if (turn < 2 || previousPromptTokens <= 0) return undefined;
  if (cacheRead / previousPromptTokens >= 0.8) return undefined;
  return { turn, expected: previousPromptTokens, got: cacheRead };
}

/** Said once per loop, after the first turn that explored with a single call. */
export const BATCH_HINT =
  'Tip: each turn is a full round trip. Send every read, search and outline you need together in one turn, or use read with files: [{path, start, end}, ...] and outline with paths: [...]. Several search terms fit in one regex (a|b).';

/** Calls that keep notes rather than do the work. */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  'todo',
  'running_context',
  'remember',
  'context',
  'recall',
]);

/** Said once per loop, after the first turn of nothing but bookkeeping. */
export const BOOKKEEPING_HINT =
  'Tip: that turn only kept notes, and each turn is a full round trip. Send todo, running_context, remember and context alongside the reads, edits or commands of the same step.';

/** Extra tries for a 400 on one call (a pool may route the retry to another model). */
const BAD_REQUEST_RETRIES = 2;

/** Failed attempts with a server error before checking whether the provider itself is up. */
export const POISON_PROBE_AFTER = 3;

/** The provider answers a trivial request but keeps failing this one: retrying can't help. */
class PoisonedRequest extends Error {}

/**
 * Top-level string values that hold a JSON array or object, decoded (once; nested strings too).
 * The input itself when nothing needed decoding, so callers can tell.
 */
export function decodeJsonStrings(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = v;
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!(t.startsWith('[') && t.endsWith(']')) && !(t.startsWith('{') && t.endsWith('}')))
      continue;
    try {
      out[k] = JSON.parse(t) as unknown;
      changed = true;
    } catch {
      // Not JSON after all: leave it for the schema to reject.
    }
  }
  return changed ? out : input;
}

/** Estimated tokens of the conversation by kind: tool results (by tool), tool calls, text. */
export function messageSegments(messages: readonly Message[]): {
  messages: number;
  toolResults: number;
  byTool: Record<string, number>;
} {
  const names = new Map<string, string>();
  const byTool: Record<string, number> = {};
  let toolResults = 0;
  for (const m of messages)
    for (const b of m.content) {
      if (b.type === 'tool_use') names.set(b.id, b.name);
      else if (b.type === 'tool_result') {
        const t = estimateTokens(b.content);
        toolResults += t;
        const name = names.get(b.toolUseId) ?? 'unknown';
        byTool[name] = (byTool[name] ?? 0) + t;
      }
    }
  return { messages: contextTokens(messages), toolResults, byTool };
}

/** The tool a call names, directly or through an alias models invent (cat → read). */
function resolveTool(byName: ReadonlyMap<string, Tool>, name: string): Tool | undefined {
  return byName.get(name) ?? byName.get(TOOL_ALIASES[name.toLowerCase()] ?? '');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Calls grouped for execution, order kept: each run of consecutive concurrency-safe calls is
 * one batch, every other call is a batch of its own.
 */
export function concurrentRuns<T extends { name: string }>(
  calls: readonly T[],
  isConcurrent: (name: string) => boolean,
): T[][] {
  return calls.reduce<T[][]>((batches, call) => {
    const last = batches.at(-1);
    const safe = isConcurrent(call.name);
    if (safe && last && isConcurrent(last[0]?.name ?? ''))
      return [...batches.slice(0, -1), [...last, call]];
    return [...batches, [call]];
  }, []);
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
    /**
     * The message compaction keeps at the top (it must be `history[0]`). Defaults to `first`;
     * a think-loop session continues one conversation, so its opening context stays the anchor.
     */
    anchor?: Message;
    /** Text a fold keeps word for word: the think phase's analysis. */
    pinned?: string;
  },
  deps: LoopDeps,
): Promise<LoopResult> {
  let messages: Message[] = [...(ctx.history ?? []), ctx.first];
  const usage: Usage = { uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  let usd = 0;
  let turns = 0;
  let cycleTokens = 0;
  let finalText = '';
  let todos: readonly TodoItem[] = [];
  let todoNudged = false;
  const byName = new Map(deps.tools.map((t) => [t.name, t]));
  const end = (e: LoopEnd): LoopResult => ({ end: e, turns, finalText, usage, usd, messages });
  // The stable prefix never changes within a cycle; size it once for the per-turn breakdown.
  const prefixTokens = {
    system: estimateTokens(ctx.system.map((b) => b.text).join('\n')),
    tools: estimateTokens(JSON.stringify(ctx.tools)),
  };

  let tokenRatios: TokenRatios = deps.calibrationFile
    ? await loadTokenRatios(deps.calibrationFile)
    : {};
  const nudged = new Set<string>();
  let batchHinted = false;
  let previousPromptTokens = 0;
  let bookkeepingHinted = false;
  let changedSomething = false;
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
    if (deps.signal?.aborted) return end('stop-now');

    if (deps.compaction && turns > 0) {
      messages = await manageContext(
        messages,
        ctx.anchor ?? ctx.first,
        ctx.pinned ? { ...deps.compaction.settings, pinned: ctx.pinned } : deps.compaction.settings,
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
    let learned: { model: string; raw: number } | undefined;
    const callStart = deps.clock.now();
    // Attempts in a row where some provider answered 5xx, and the last one that did.
    let serverFailures = 0;
    let badRequests = 0;
    let lastServerFailure: ResolvedModel | undefined;
    try {
      res = await withRetry(
        async () => {
          // After a few server errors, check whether the provider answers a trivial request.
          // If it does and this request still fails, the request itself is the problem: an
          // outage fails both, and one that just ended lets this attempt through.
          if (serverFailures >= POISON_PROBE_AFTER && lastServerFailure) {
            const m = lastServerFailure;
            const up = await deps.provider
              .complete({
                model: m.id,
                route: m.provider,
                system: [{ text: 'Reply with: ok' }],
                tools: [],
                messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
                maxTokens: 16,
                messageBreakpoints: [],
              })
              .then(
                () => true,
                () => false,
              );
            if (up) {
              // The provider is up: send the real request once more, cooling or not.
              try {
                const req = {
                  ...turnRequest(ctx, messages, m.id, deps.maxTokens, deps.cacheKey),
                  route: m.provider,
                  ...(deps.signal ? { signal: deps.signal } : {}),
                };
                const quote = pricedPrompt(tokenRatios, m, req);
                const r = await deps.provider.complete(req);
                chosen = m;
                learned = { model: quote.key, raw: quote.raw };
                return r;
              } catch (err) {
                if (err instanceof ProviderError && (err.status ?? 0) >= 500)
                  throw new PoisonedRequest(
                    `${m.provider}:${m.id} answers other requests but failed this one ${serverFailures + 1} times`,
                  );
                throw err;
              }
            }
          }
          let sawServerError = false;
          let triedAny = false;
          const skipped: string[] = [];
          let onlyBudget = true;
          const order = callOrder(deps.models, deps.strategy);
          // Soft blocks (a model out of quota or rate-limited, a provider cooling down after a
          // failure) are skipped while another model can take the call; when none can, they are
          // tried anyway: one real retry beats sitting out the window with nothing to call (each
          // cost minutes a run). Hard blocks (a spending cap) always hold.
          const blockOf = (m: (typeof order)[number]): string | undefined =>
            deps.providerBlocked?.(m.provider);
          const cooling = (b: string | undefined): boolean =>
            b?.startsWith('cooling down') === true;
          const benched = (m: (typeof order)[number]): boolean =>
            skipsOutModels(deps.strategy) &&
            deps.modelExhausted?.(`${m.provider}:${m.id}`) === true;
          const soft = (m: (typeof order)[number]): boolean => benched(m) || cooling(blockOf(m));
          const hard = (m: (typeof order)[number]): boolean => {
            const b = blockOf(m);
            return b !== undefined && !cooling(b);
          };
          const anyFree = order.some((m) => !soft(m) && !hard(m));
          for (const m of order) {
            const blocked = blockOf(m);
            if (hard(m)) {
              if (!blocked?.includes('max_usd')) onlyBudget = false;
              skipped.push(`${m.provider}: ${blocked ?? ''}`);
              continue;
            }
            if (anyFree && soft(m)) {
              onlyBudget = false;
              skipped.push(
                benched(m)
                  ? `${m.provider}:${m.id}: out of quota`
                  : `${m.provider}: ${blocked ?? ''}`,
              );
              continue;
            }
            const req = turnRequest(ctx, messages, m.id, deps.maxTokens, deps.cacheKey);
            const quote = pricedPrompt(tokenRatios, m, req);
            const estimate = quote.estimate;
            const pf = preflight(deps.budget, {
              spentUsd: deps.spentUsd(),
              ...(deps.spentTodayUsd ? { spentTodayUsd: deps.spentTodayUsd() } : {}),
              cycle: { turns, tokens: cycleTokens },
              estimatedInputTokens: estimate,
              maxOutputTokens: deps.maxTokens,
              price: m.price,
            });
            if (!pf.ok) throw new BudgetStopSignal(pf.stop, pf.detail);
            triedAny = true;
            const ref = `${m.provider}:${m.id}`;
            const sentAt = deps.clock.now();
            deps.onRequest?.({ model: ref, inputTokens: estimate });
            try {
              const r = await deps.provider.complete({
                ...req,
                route: m.provider,
                ...(deps.onDelta ? { onDelta: deps.onDelta } : {}),
                ...(deps.signal ? { signal: deps.signal } : {}),
              });
              chosen = m;
              learned = { model: quote.key, raw: quote.raw };
              deps.onResponse?.({
                model: ref,
                inputTokens: estimate,
                ms: deps.clock.now() - sentAt,
              });
              return r;
            } catch (err) {
              // A 400 is usually our own mistake, but behind a model pool the next try can land on
              // a different model: give it two more chances before failing the call.
              if (
                err instanceof ProviderError &&
                err.status === 400 &&
                !err.contentFilter &&
                !isQuotaError(err) &&
                badRequests++ < BAD_REQUEST_RETRIES
              ) {
                deps.events.emit('provider.retry_400', {
                  provider: m.provider,
                  error: err.message,
                });
                throw new ProviderError(err.message, { retryable: true, status: 400 });
              }
              if (!shouldFailover(err)) throw err;
              onlyBudget = false;
              if ((err.status ?? 0) >= 500) {
                sawServerError = true;
                lastServerFailure = m;
              }
              // Out of quota: only this model is done, the provider's other models may still have some.
              if (deps.markExhausted && isQuotaError(err))
                deps.markExhausted(`${m.provider}:${m.id}`);
              // A content filter refused this request only: the provider stays usable.
              // Transient trouble: retry this provider soon. Key or model problems: much later.
              else if (!err.contentFilter)
                deps.coolProvider?.(m.provider, err.retryable ? 60_000 : 30 * 60_000);
              // Fallback lists stay off a rate-limited model until it recovers, across sessions.
              if (err.status === 429 && !isQuotaError(err) && sticksOnRateLimit(deps.strategy))
                deps.markRateLimited?.(`${m.provider}:${m.id}`, RATE_LIMITED_FOR_MS);
              deps.events.emit('provider.failover', {
                provider: m.provider,
                model: m.id,
                error: err.message,
                status: err.status,
              });
              skipped.push(`${m.provider}: ${err.message}`);
            }
          }
          // Attempts where every provider was cooling down tried nothing: they don't reset it.
          if (sawServerError) serverFailures++;
          else if (triedAny) serverFailures = 0;
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
          ...(deps.retry?.giveUpAfterMs !== undefined
            ? { giveUpAfterMs: deps.retry.giveUpAfterMs }
            : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        },
      );
    } catch (err) {
      if (err instanceof StopRequested) return end('stop');
      if (err instanceof ProvidersUnavailable) {
        deps.events.emit('provider.give_up', { waitedMs: err.waitedMs, error: err.lastError });
        return { ...end('providers_unavailable'), detail: err.lastError };
      }
      // Esc in chat: end the turn cleanly, keeping every completed step.
      if (deps.signal?.aborted) return end('stop-now');
      if (err instanceof PoisonedRequest) {
        const finding: StuckFinding = { signal: 'poisoned_request', detail: err.message };
        deps.events.emit('stuck.in_cycle', {
          signal: finding.signal,
          detail: finding.detail,
          turn: turns,
        });
        return { ...end('stuck'), stuck: finding };
      }
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
    if (learned && deps.calibrationFile) {
      const next = observeTokenRatio(
        tokenRatios,
        learned.model,
        learned.raw,
        totalInput(res.usage),
      );
      const ratio = next?.[learned.model];
      if (next && ratio !== undefined) {
        tokenRatios = next;
        await saveTokenRatio(deps.calibrationFile, learned.model, ratio).catch(() => undefined);
      }
    }
    const model = chosen ?? deps.models[0];
    if (!model) throw new ProviderError('empty model chain', { retryable: false });
    turns++;
    const cost = costUsd(res.usage, model.price);
    usd += cost;
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += res.usage[k];
    cycleTokens += budgetTokens(res.usage);
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
      // Estimated input by segment, to see where the tokens go (W8 "measure first").
      segments: { ...prefixTokens, ...messageSegments(messages) },
      usd: cost,
    });
    const miss = cacheShortfall(turns, previousPromptTokens, res.usage.cacheRead);
    if (miss) deps.events.emit('cache.miss', miss);
    previousPromptTokens = input;

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
    // What the model said or reasoned on its way to a tool call: shown as "thinking".
    // A final answer (no tool call) is shown as the reply itself, so its reasoning isn't
    // repeated after it.
    const thought = calls.length ? text || res.reasoning?.trim() : undefined;
    if (thought) deps.events.emit('agent.thinking', { text: thought.slice(0, 600) });
    if (res.stopReason === 'refusal') return end('refusal');
    for (const c of calls) if (c.name === todoTool.name) todos = todoItemsOf(c.input) ?? todos;
    if (calls.length === 0) {
      const late = deps.pendingInput?.() ?? [];
      const open = todos.filter((i) => i.status !== 'done');
      if (!late.length && open.length && !todoNudged) {
        // Models often stop with the checklist half ticked; one reminder, then trust the answer.
        todoNudged = true;
        deps.events.emit('todo.nudge', { open: open.length });
        messages.push({ role: 'user', content: [{ type: 'text', text: todoNudge(open) }] });
        continue;
      }
      if (!late.length) return end('done');
      // The person wrote while the model was finishing: answer that before ending the turn.
      messages.push({ role: 'user', content: [{ type: 'text', text: steeringText(late) }] });
      deps.events.emit('steer.applied', { count: late.length, turn: turns });
      continue;
    }

    const finished = { now: false };
    const runCall = async (call: (typeof calls)[number]): Promise<ContentBlock> => {
      const tool = resolveTool(byName, call.name);
      let content: string;
      let isError: boolean;
      let miss = false;
      const toolStart = deps.clock.now();
      deps.events.emit('tool.start', {
        tool: call.name,
        // An invented name (print_tree) is narrated as the tool that actually runs (outline).
        doing: narrateTool(
          tool?.name ?? call.name,
          typeof call.input === 'object' && call.input !== null
            ? (call.input as Record<string, unknown>)
            : {},
        ),
      });
      if (!tool) {
        content = `unknown tool ${call.name}; the tools are: ${[...byName.keys()].join(', ')}${byName.has('bash') ? ' (list files with bash, e.g. `ls -R src`)' : ' (you cannot run commands here; list files with search)'}`;
        isError = true;
      } else {
        const prepare = (v: unknown) => (tool.normalize ? tool.normalize(v) : v);
        let parsed = tool.schema.safeParse(prepare(call.input));
        // Models often send a nested array or object as a JSON string ("milestones": "[{…}]").
        // Decode before normalizing: a normalizer may reshape the string beyond recovery.
        if (!parsed.success) {
          const decoded = decodeJsonStrings(call.input);
          if (decoded !== call.input) {
            const again = tool.schema.safeParse(prepare(decoded));
            if (again.success) parsed = again;
          }
        }
        // Models name arguments their own way (line_start, file_path) and add extras (max_results).
        if (!parsed.success) {
          const lenient = lenientInput(tool.schema, call.input);
          if (lenient !== undefined) {
            const again = tool.schema.safeParse(prepare(lenient));
            if (again.success) parsed = again;
          }
        }
        if (!parsed.success) {
          content = `invalid input for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
          isError = true;
        } else {
          const out = await tool.run(parsed.data, deps.toolCtx);
          content = out.content;
          isError = out.isError === true;
          miss = out.miss === true;
          if (out.final && !isError) finished.now = true;
        }
      }
      content = deps.toolCtx.redactor.text(content);
      deps.events.emit('tool.call', {
        tool: call.name,
        input: summarizeInput(call.input),
        isError,
        ...(miss ? { miss: true } : {}),
        // Already redacted above. Enough to see why it failed without opening the transcript.
        ...(isError ? { error: content.slice(0, 500) } : {}),
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
    // Otherwise runs of consecutive concurrency-safe calls (reads, searches) go out together;
    // every other call runs alone, in order, so writes and commands never interleave.
    const batches = calls.every((c) => c.name === 'task')
      ? chunk(calls, deps.parallelTasks ?? 1)
      : concurrentRuns(calls, (name) => resolveTool(byName, name)?.concurrent === true);
    for (const batch of batches) results.push(...(await Promise.all(batch.map(runCall))));
    if (calls.some((c) => resolveTool(byName, c.name)?.readOnly !== true)) changedSomething = true;
    const lone = calls.length === 1 ? calls[0] : undefined;
    if (!batchHinted && !changedSomething && lone && EXPLORE_TOOLS.has(lone.name)) {
      batchHinted = true;
      results.push({ type: 'text', text: BATCH_HINT });
      deps.events.emit('loop.batch_hint', { turn: turns, tool: lone.name });
    }
    if (!bookkeepingHinted && !finished.now && calls.every((c) => BOOKKEEPING_TOOLS.has(c.name))) {
      bookkeepingHinted = true;
      results.push({ type: 'text', text: BOOKKEEPING_HINT });
      deps.events.emit('loop.bookkeeping_hint', { turn: turns });
    }
    const steer = deps.pendingInput?.() ?? [];
    if (steer.length) {
      results.push({ type: 'text', text: steeringText(steer) });
      deps.events.emit('steer.applied', { count: steer.length, turn: turns });
    }
    messages.push({ role: 'user', content: results });
    // Weaker models keep calling tools after the job is done; don't pay for that.
    if (finished.now) return end('done');

    const finding = deps.watch?.afterTurn(turns, cycleTokens, calls);
    if (finding) {
      deps.events.emit('stuck.in_cycle', {
        signal: finding.signal,
        detail: finding.detail,
        turn: turns,
      });
      if (deps.watchMode === 'nudge' && !nudged.has(finding.signal)) {
        nudged.add(finding.signal);
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: stuckNudge(finding.detail) }],
        });
        continue;
      }
      return { ...end('stuck'), stuck: finding };
    }
  }
}
