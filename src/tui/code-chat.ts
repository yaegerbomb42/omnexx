import { turnTraceLine } from '../telemetry/humanize.js';
import { emptyTrace, pushTrace, type TraceAcc } from '../telemetry/turn-trace.js';
import { thinkingGist } from '../telemetry/narrate.js';
import { agentBriefFor } from '../config/agent-settings.js';
import { InCycleWatch } from '../guard/stuck.js';
import { orderForStrategy, strategyFor, type Strategy } from '../config/routing.js';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCodemap, renderCodemap } from '../agent/codemap.js';
import { capChatHistory, trimChatHistory } from '../agent/chat-context.js';
import { contextTokens, transcriptFor } from '../agent/compaction.js';
import { runAgentLoop, type LoopDeps } from '../agent/loop.js';
import type { CliIO } from '../cli/io.js';
import { resolveRunDeps } from '../cli/run-deps.js';
import type { OmnexxConfig } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { parseDuration } from '../config/duration.js';
import { EventLog, type OmnexxEvent } from '../core/events.js';
import { RunStore } from '../core/run-store.js';
import { RunningContext } from '../core/running-context.js';
import { readTextOr, writeJsonAtomic } from '../core/atomic.js';
import { runsDir, usageFile } from '../core/paths.js';
import { QuotaLedger } from '../providers/quota-ledger.js';
import { UsageLedger } from '../providers/usage-ledger.js';
import { restoreTree, snapshotTree } from './undo.js';
import { renderNotes } from '../core/notes.js';
import type { OmnexxPaths } from '../core/paths.js';
import { readRepoNotes, saveToRepoMemory } from '../core/repo-memory.js';
import { FactRecorder } from '../core/fact-recorder.js';
import { factsBlockFor } from '../core/facts.js';
import { runShell } from '../core/exec.js';
import { realClock, type Clock } from '../core/clock.js';
import { tokenCalibrationFile } from '../core/token-calibration.js';
import { estimateTokens } from '../core/tokens.js';
import { loadInstructions, renderInstructions } from '../instructions/load.js';
import type { ResolvedModel } from '../providers/pricing.js';
import { resolveModelLenient } from '../providers/profiles.js';
import type { ContentBlock, Message, Provider } from '../providers/types.js';
import { scrubEnv } from '../security/env-scrub.js';
import { PathJail } from '../security/paths.js';
import { Redactor } from '../security/redact.js';
import { readOnlyTools, workerTools, toolSpec } from '../tools/registry.js';
import type { ToolWhere } from '../tools/extra/types.js';
import { helperRunner } from '../agent/subagent.js';
import type { TodoItem } from '../tools/todo.js';
import type { Tool, ToolContext } from '../tools/types.js';
import { runHistoryFile } from '../core/run-history.js';
import { ChatEstimate } from './chat-estimate.js';
import { CHAT_FILE, listChats, readSavedChat, type ChatSummary } from './chat-history.js';
import {
  estimateLatency,
  loadLatency,
  recordLatency,
  saveLatency,
  type LatencyStats,
} from './latency.js';
import {
  applyContext,
  clearContextHistory,
  deleteContextItem,
  EMPTY_OVERRIDES,
  listContext,
  updateContextItem,
  type ContextItem,
  type ContextOverrides,
  type ContextState,
} from './context-edit.js';
import { runGates } from '../verify/gates.js';
import { emptyTelemetry, fold, type Telemetry } from '../telemetry/aggregate.js';

/** Questions read without editing; only this many turns in a row without an edit is circling. */
const CHAT_NO_EDIT_TURNS = 25;
/** How many times one message may summarize and keep going after running out of room. */
const CHAT_CONTINUES = 3;
const CONTINUE_ENDS: ReadonlySet<string> = new Set(['max_tokens_per_cycle', 'max_turns_per_cycle']);

function continuePrompt(ask: string): string {
  return `Continue the task from the summary above; don't redo finished steps or re-read files you already read unless they changed. The request was:\n\n${ask}`;
}

/** The model a chat answers on: the one picked, else the first of the worker list. */
function identityRef(
  ref: string | readonly string[] | undefined,
  config: OmnexxConfig,
): string | undefined {
  const picked = typeof ref === 'string' ? ref : ref?.[0];
  if (picked) return picked;
  const w = config.models.worker;
  return typeof w === 'string' ? w : w[0];
}

/** What the model is told about itself, so "which model are you?" gets a true answer. */
export function identityLine(ref: string): string {
  return `You are omnexx, a coding agent, running on the model ${ref} (provider:model). If asked which model you are, say exactly that; don't guess another name.`;
}

function kTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A saved chat's id: `chat_<UTC timestamp>_<random>`. */
function newChatId(): string {
  return `chat_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`;
}

export const CHAT_SYSTEM = `You are Omnexx in chat mode: a collaborative coding partner working turn by turn with a person at the keyboard, directly in their repository (your cwd).

- USER-FIRST CONVERSATION RULE: Whenever the user sends a greeting (hello, hi, hey, good morning), asks a conversational question, or initiates chat without an explicit coding instruction, RESPOND DIRECTLY IN CHAT FIRST. Do not start scanning or reading repository files, executing search tools, or launching autonomous actions when the user just said hello or asked a question. Greet them warmly and ask how you can help with their project.
- Do what they ask, then stop and reply briefly: what you changed and what you checked.
- For anything with more than two steps, write a todo list first with the todo tool and keep it current: one item in_progress at a time, done as you finish.
- Use the context tool to pull in wider context (general, repo, heat, recent) only when it helps; save what you learn about the codebase with context update.
- Each turn: one short sentence on what you are doing and why, then every call you can make now in the same turn (read all the files you need at once, search and read together, send todo updates alongside). Independent reads and searches run in parallel. Don't read a file again unless it changed; use ranges from what you already have.
- Explore with the codebase map, outline, search and ranged reads. Edit with str_replace / multi_edit (or replace_lines after a read with anchors: true); write_file for new or small files.
- Run the relevant tests with bash before you finish when you changed code.
- The person may send messages while you work; they arrive marked as such. Read them and adjust at once.
- You can work outside the repo (e.g. make a folder on their Desktop) and run commands the policy normally refuses: just make the tool call and they are asked to approve it. Never refuse or tell them to do it themselves before trying; if they say no, find another way or explain.
- Work like a senior engineer: look first (map, search, read the relevant files), then decide. Never reply with a menu of questions.
- Small, clear request: just do it. Vague or larger one ("improve the UI", several files): after looking, reply with a short plan and stop without editing: "I looked at <files>. Plan: 1) … 2) … 3) … Go ahead, or change anything?" When they approve, carry it out; if they edit it, adjust and go.
- Ask only when blocked by something you can't find out yourself (a credential, an outside account, a choice only they can make).
- A greeting or small talk gets one short line, like "How can I help today?", with no tools.`;

/** Prepended to a message in plan mode. */
const PLAN_MODE = `[Plan mode] Don't change anything yet: no edits and no commands. Investigate with the read-only tools, then reply with a concrete step-by-step plan: the files to change and how, the approach, how you will test it, and any risks. Put the steps in the todo list. Stop after the plan; I'll approve it or ask for changes.`;

/** Where response times are kept between sessions. */
function latencyFile(paths: OmnexxPaths): string {
  return join(paths.configHome, 'latency.json');
}

/** Tools chat leaves out: helpers need a run. */
const CHAT_DENIED = new Set(['task']);

/** What the chat shows the person. */
export type ChatLine =
  | { kind: 'act'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'out'; text: string }
  | { kind: 'feed'; text: string }
  | { kind: 'err'; text: string };

/** The agent's browser after an action, for a live view (the image is a file under the logs). */
export interface BrowserFrame {
  path: string;
  mime: string;
  url: string;
  action: string;
}

/** Frontend problems found after a browser action, shown in the cockpit's console/network tabs. */
export interface BrowserDiagnosticsView {
  action: string;
  url: string;
  errors: number;
  warnings: number;
  failedRequests: number;
  console: { type: string; text: string; location?: string }[];
  requests: {
    method: string;
    url: string;
    status?: number;
    resourceType?: string;
    failure?: string;
  }[];
  summary: string;
}

/** A visual comparison result, with the diff image path when something changed. */
export interface BrowserVisualView {
  name: string;
  pass: boolean;
  changedPixels: number;
  totalPixels: number;
  changedRatio: number;
  width: number;
  height: number;
  dimensionsMatch: boolean;
  baselineWidth: number;
  baselineHeight: number;
  currentWidth: number;
  currentHeight: number;
  meanDelta: number;
  baseline: string;
  current: string;
  diff?: string;
}

/** A helper (subagent) starting or finishing, for a live view of who is doing what. */
export type HelperEvent =
  | { phase: 'start'; id: number; kind: string; agent?: string; description: string }
  | { phase: 'finish'; id: number; end: string; turns: number; usd: number };

export interface ChatView {
  line: (l: ChatLine) => void;
  browser?: (f: BrowserFrame) => void;
  browserDiagnostics?: (d: BrowserDiagnosticsView) => void;
  browserVisual?: (v: BrowserVisualView) => void;
  helper?: (h: HelperEvent) => void;
  /** Reply text as it streams in (cleared when the reply lands as an `out` line). */
  stream: (delta: string) => void;
  todo: (items: TodoItem[]) => void;
  /** A model request went out (with an expected duration when there is history), or answered (null). */
  waiting?: (w: { startedAt: number; estimateMs: number | null } | null) => void;
  /** Approved plan work: "est. ~3 min, …" when it starts, "~2 min left" as todos finish, null at the end. */
  estimate?: (line: string | null) => void;
}

/** The line of a failed action's output worth showing: the error, not the `[exit 1, …]` header. */
export function errorLine(t: string): string {
  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const telling = lines.find(
    (l) =>
      !l.startsWith('[exit') &&
      /error|fail|not ok|assert|expected|cannot|denied|refused|✗/i.test(l),
  );
  return telling ?? lines.find((l) => !l.startsWith('[exit')) ?? lines[0] ?? '';
}

/** Price an unpriced model at $0 so chat works on any endpoint; spend then reads $0.00. */
function chatModel(ref: string, config: OmnexxConfig): ResolvedModel {
  const m = resolveModelLenient(ref, config);
  return {
    ...m,
    price: m.price ?? {
      id: m.id,
      input: 0,
      output: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_read: 0,
    },
  };
}

/**
 * Turn-by-turn coding in the user's own checkout (no worktree, no rollback). The conversation
 * carries across messages; messages typed mid-turn reach the model at its next step; Esc ends a
 * turn cleanly; long conversations are trimmed, then summarized, between messages.
 */
const GREETING_PATTERN =
  /^\s*(?:hi|hello|hey|howdy|good\s+(?:morning|afternoon|evening)|what'?s\s+up|sup|greetings)(?:[\s,.!?:;]+(?:omnexx|there|bot|agent|friend|assistant))?[\s,.!?:;]*$/i;

/** Returns true if text is purely a conversational greeting or small-talk check-in. */
export function isConversationalGreeting(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 60) return false;
  return GREETING_PATTERN.test(trimmed);
}

export class CodeChat {
  /** The last thinking line shown, so an identical one isn't printed again. */
  private lastThought = '';
  private history: Message[] = [];
  /** Context-inspector edits to the system prompt and tool definitions. */
  private overrides: ContextOverrides = EMPTY_OVERRIDES;
  /** Recent response times per model, for the editor's countdown. */
  private latency: LatencyStats = {};
  /** Estimates for work started by approving a plan; replaced in open() with a saving one. */
  private estimator = new ChatEstimate(undefined, { model: () => this.model, repoFiles: 0 });
  /** The agent's latest todo list (a plan's steps). */
  private todos: TodoItem[] = [];
  /** The saved chat this one continues, if it was reopened from History. */
  private resumedFrom: string | undefined;
  /** Set by open(); where repo memory lives. */
  paths: OmnexxPaths | undefined;
  /** The shared usage ledger, so chat and its helpers are attributed like a run. */
  private ledger: UsageLedger | undefined;
  /** Records what passed into the repo's verified facts. */
  facts: FactRecorder | undefined;
  /** Before each message: the files as they were, and how long the conversation was. */
  private snapshots: { tree: string | undefined; historyLength: number }[] = [];
  private queue: string[] = [];
  private abort: AbortController | undefined;
  private view: ChatView | undefined;
  private models: ResolvedModel[];
  /** How the chat's ranked models are used per call (random, priority, fallback). */
  readonly strategy: Strategy;
  usd = 0;
  /** Token, tool and turn totals for this conversation, folded from its events. */
  telemetry: Telemetry = emptyTelemetry();
  /** `/trace`: fold turn events into a compact line. Off until the session turns it on. */
  private showTrace = false;
  private traceAcc: TraceAcc = emptyTrace();

  /** Session toggle. Resets the open turn so a late enable does not print a partial history. */
  setTrace(on: boolean): void {
    this.showTrace = on;
    this.traceAcc = emptyTrace();
  }
  /** Every successful edit, repeat edits to one file included (the no-edits watch counts these). */
  private editOps = 0;
  /** Estimated tokens the next request starts with (system + tools + conversation). */
  contextUsed = 0;

  private constructor(
    private readonly config: OmnexxConfig,
    private readonly provider: Provider,
    private readonly tools: readonly Tool[],
    private readonly system: { text: string; cacheBreakpoint?: boolean }[],
    private readonly ctx: ToolContext,
    private readonly events: EventLog,
    private readonly store: RunStore,
    model: string | undefined,
  ) {
    const refs = model ? [model] : config.models.worker;
    this.strategy = strategyFor(config.models, 'chat');
    this.models = orderForStrategy(
      (typeof refs === 'string' ? [refs] : refs).map((r) => chatModel(r, config)),
      this.strategy,
    );
    this.contextUsed = this.baseTokens();
    ctx.onEdit = () => {
      this.editOps++;
    };
    // One listener for the whole chat: every action shows as a line while it happens.
    events.onEvent((e) => {
      fold(this.telemetry, e);
      this.onEvent(e);
    });
  }

  static async open(
    io: CliIO,
    ask: (q: string) => Promise<boolean>,
    model?: string,
  ): Promise<CodeChat> {
    // Build the provider for the chat model only (not every role's), so chatting on one
    // endpoint never needs keys for the others.
    const { config: base } = await loadConfig({ cwd: io.cwd, env: io.env });
    const ref = model ?? base.models.chat;
    const { config, paths, deps } = await resolveRunDeps(
      io,
      io.cwd,
      ref ? { models: { planner: ref, worker: ref, cheap: ref } } : {},
    );
    const store = new RunStore(paths, newChatId());
    await mkdir(store.logsDir, { recursive: true, mode: 0o700 });
    const redactor = Redactor.fromEnv(io.env, deps.secrets);
    const clock = io.clock ?? realClock;
    const events = new EventLog(store.eventsPath, store.runId, redactor, clock);
    const tmp = join('/tmp', `omnexx-${store.runId}`);
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const jail = new PathJail(io.cwd);
    let n = 0;
    const facts = new FactRecorder({
      paths,
      repoRoot: jail.root,
      workdir: jail.root,
      gateCommands: config.gates.map((g) => g.run),
      now: () => clock.now(),
    });
    const ctx: ToolContext = {
      jail,
      exec: facts.wrap(runShell),
      env: scrubEnv(io.env, { passthrough: config.policy.env_passthrough, set: { TMPDIR: tmp } }),
      store,
      events,
      redactor,
      policy: {
        root: jail.root,
        home: io.env.HOME ?? '/nonexistent',
        allowNetwork: config.policy.allow_network,
        extraDeny: config.policy.deny,
        scratch: [tmp, `/private${tmp}`],
      },
      cycle: 0,
      maxCmdTimeoutMs: parseDuration(config.budget.max_cmd_timeout),
      notesMaxTokens: config.context.notes_max_tokens,
      today: new Date(clock.now()).toISOString().slice(0, 10),
      nextCommandId: () => `cmd-chat-${++n}`,
      edited: new Set(),
      reads: new Map(),
      ask,
      runningContext: new RunningContext(store, 'chat'),
    };
    const tools = (await workerTools(config, { repoRoot: jail.root, env: io.env })).filter(
      (t) => !CHAT_DENIED.has(t.name),
    );
    const instructions = renderInstructions(await loadInstructions(jail.root, jail.root));
    const map = await buildCodemap(jail.root);
    const codemap = renderCodemap(map, config.context.repo_map_max_tokens);
    // What earlier runs and chats learned about this repo; the remember tool adds to it.
    const known = await readRepoNotes(paths, jail.root);
    if (known.length) await store.writeNotes(known);
    const factsBlock = await factsBlockFor(
      paths,
      jail.root,
      jail.root,
      known.map((k) => k.text),
    );
    const system = [
      { text: CHAT_SYSTEM },
      ...(instructions ? [{ text: instructions }] : []),
      ...(known.length ? [{ text: `# Lessons about this repo\n\n${renderNotes(known)}` }] : []),
      { text: codemap, cacheBreakpoint: true },
      // The user's agent settings (effort, time): after the cached prefix, so it never busts it.
      ...(agentBriefFor(config) ? [{ text: agentBriefFor(config) ?? '', volatile: true }] : []),
      // What ran and passed here before; volatile, since a passing command can add to it.
      ...(factsBlock ? [{ text: factsBlock, volatile: true }] : []),
      // Models guess their own name ("Claude 3.5 Sonnet") unless told; after the cached prefix.
      ...(identityRef(ref, config)
        ? [{ text: identityLine(identityRef(ref, config) ?? ''), volatile: true }]
        : []),
    ];
    const chat = new CodeChat(config, deps.provider, tools, system, ctx, events, store, model);
    chat.paths = paths;
    chat.ledger = new UsageLedger(usageFile(paths), store.runId, 'chat');
    chat.facts = facts;
    chat.latency = await loadLatency(latencyFile(paths));
    chat.estimator = new ChatEstimate(runHistoryFile(paths), {
      model: () => chat.model,
      repoFiles: map.entries.length,
    });
    // Chat gets helpers too (the task and agent tools), on the chat model and the chat's spend.
    ctx.subagent = chat.helpers({ repoRoot: jail.root, env: io.env }, clock);
    return chat;
  }

  /** Read-only helpers that run on this chat's model, budget and spend. */
  helpers(where: ToolWhere, clock: Clock): NonNullable<ToolContext['subagent']> {
    const cfg = this.config.context;
    return helperRunner(
      {
        tools: () => readOnlyTools(this.config, where),
        // models.helpers when set (so helpers can draw on other providers' quotas), else chat's.
        models: () => Promise.resolve(this.helperModels()),
        strategy: strategyFor(this.config.models, 'helpers'),
        maxTokens: Math.min(this.config.providers.anthropic.max_tokens, 4_096),
        limits: { tokens: cfg.subagent_max_tokens, turns: cfg.subagent_max_turns },
        loop: {
          provider: this.provider,
          budget: this.config.budget,
          clock,
          events: this.events,
          spentUsd: () => this.usd,
          onUsage: (u, usd, model, provider, meta) => {
            this.usd += usd;
            this.ledger?.recordCall(meta ?? { purpose: 'subagent' }, {
              model,
              provider,
              usage: u,
              usd,
            });
            return Promise.resolve();
          },
          control: () => Promise.resolve(this.paused ? 'pause' : 'continue'),
          pausePollMs: 300,
        },
      },
      this.ctx,
    );
  }

  private helperModels(): ResolvedModel[] {
    const h = this.config.models.helpers;
    if (!h) return this.models;
    return (typeof h === 'string' ? [h] : h).map((ref) => chatModel(ref, this.config));
  }

  /** The ref that answered last, once one has (a ranked list can move between models). */
  private served: string | undefined;

  /** "provider:model" of the model chat talks to: the last one that answered, else #1. */
  get model(): string {
    if (this.served) return this.served;
    const m = this.models[0];
    return m ? `${m.provider}:${m.alias}` : '?';
  }

  /** The routing mode when the chat has several models to choose from, for the status line. */
  get routing(): Strategy | undefined {
    return this.models.length > 1 ? this.strategy : undefined;
  }

  /** The conversation so far, to carry into a chat on another model (/model). */
  get conversation(): Message[] {
    return this.history;
  }

  set conversation(m: Message[]) {
    this.history = m;
    this.contextUsed = this.baseTokens() + contextTokens(m);
  }

  get busy(): boolean {
    return this.abort !== undefined;
  }

  /** Why the current turn was cut short, so its ending says the right thing. */
  private abortReason: 'stop' | 'pause' | 'steer' | undefined;

  /** True after an immediate pause cut a turn short; /resume carries it on. */
  pausedTurn = false;

  /**
   * A message typed while the agent works: the current step (model call or command) is cut
   * short at once, keeping every completed step, and the message is answered next.
   */
  steer(text: string): void {
    // Held aside (not in the loop's queue, which would fold it into the turn being cut short),
    // then answered as the next turn.
    this.steered.push(text);
    if (!this.abort) return;
    this.abortReason = 'steer';
    this.abort.abort();
  }

  /** Messages that cut a turn short, answered next. */
  private readonly steered: string[] = [];

  /** /pause: stop the current step at once (completed steps are kept); /resume carries on. */
  pauseNow(): void {
    if (!this.abort) return;
    this.abortReason = 'pause';
    this.pausedTurn = true;
    this.abort.abort();
  }

  /** Messages that arrived after the agent's last step: the session sends them next. */
  takeLeftovers(): string[] {
    return [...this.queue.splice(0), ...this.steered.splice(0)];
  }

  /** /pause: hold at the next step boundary until resume() (the loop polls control()). */
  paused = false;

  /** Esc: end the current turn at once, keeping every completed step. */
  interrupt(): void {
    if (!this.abort) return;
    this.abortReason = 'stop';
    this.abort.abort();
  }

  /** The context limit the chat compacts at. */
  get contextLimit(): number {
    return this.config.context.compact_at;
  }

  private baseTokens(): number {
    const { system, tools } = this.effective(this.tools);
    return estimateTokens(JSON.stringify([system, tools]));
  }

  private contextState(): ContextState {
    return {
      system: this.system,
      tools: this.tools.map(toolSpec),
      history: this.history,
      overrides: this.overrides,
    };
  }

  /** The system prompt and tools a request sends, with the inspector's edits applied. */
  private effective(tools: readonly Tool[]): {
    system: { text: string; cacheBreakpoint?: boolean }[];
    tools: ReturnType<typeof toolSpec>[];
    runnable: Tool[];
  } {
    const applied = applyContext({ ...this.contextState(), tools: tools.map(toolSpec) });
    const kept = new Set(applied.tools.map((t) => t.name));
    return {
      system: applied.system,
      tools: applied.tools,
      runnable: tools.filter((t) => kept.has(t.name)),
    };
  }

  /** Everything the next request sends, item by item, for the context inspector. */
  contextItems(): ContextItem[] {
    return listContext(this.contextState());
  }

  private changeContext(next: ContextState): void {
    if (this.busy)
      throw new Error('wait for the agent to finish (or stop it), then edit the context');
    this.overrides = next.overrides;
    this.conversation = [...next.history];
  }

  editContext(id: string, text: string): void {
    this.changeContext(updateContextItem(this.contextState(), id, text));
  }

  deleteContext(id: string): void {
    this.changeContext(deleteContextItem(this.contextState(), id));
  }

  /** Any other inspector change (add a note, pin, restore one item), as a pure function. */
  transformContext(change: (s: ContextState) => ContextState): void {
    this.changeContext(change(this.contextState()));
  }

  /** Clear all conversation and tooling history; system blocks, tools, and user notes stay intact. */
  clearHistory(): void {
    this.changeContext(clearContextHistory(this.contextState()));
    this.ctx.reads?.clear();
    this.contextUsed = this.baseTokens();
  }

  /** Bring back the default system prompt and tools (conversation edits and notes stay). */
  resetContext(): void {
    this.changeContext({
      ...this.contextState(),
      overrides: { ...EMPTY_OVERRIDES, notes: this.overrides.notes ?? [] },
    });
  }

  /**
   * What the context is made of, for the editor: the system prompt (instructions, project notes),
   * every tool's definition, and the conversation. The first two are sent with every request,
   * even before anything is said.
   */
  get contextParts(): { system: number; tools: number; conversation: number } {
    const applied = this.effective(this.tools);
    const system = estimateTokens(JSON.stringify(applied.system));
    const tools = estimateTokens(JSON.stringify(applied.tools));
    return { system, tools, conversation: Math.max(0, this.contextUsed - system - tools) };
  }

  private onEvent(e: OmnexxEvent): void {
    const closed = this.showTrace ? pushTrace(this.traceAcc, e) : undefined;
    const v = this.view;
    if (!v) return;
    if (closed) v.line({ kind: 'feed', text: turnTraceLine(closed) });
    const str = (x: unknown): string => (typeof x === 'string' ? x : '');
    const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
    const bool = (x: unknown): boolean => x === true;
    const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
    switch (e.type) {
      case 'browser.frame':
        v.browser?.({
          path: str(e.path),
          mime: str(e.mime),
          url: str(e.url),
          action: str(e.action),
        });
        return;
      case 'browser.diagnostics':
        v.browserDiagnostics?.({
          action: str(e.action),
          url: str(e.url),
          errors: num(e.errors),
          warnings: num(e.warnings),
          failedRequests: num(e.failedRequests),
          console: list<{ type: string; text: string; location?: string }>(e.console),
          requests: list<{
            method: string;
            url: string;
            status?: number;
            resourceType?: string;
            failure?: string;
          }>(e.requests),
          summary: str(e.summary),
        });
        return;
      case 'browser.visual':
        v.browserVisual?.({
          name: str(e.name),
          pass: bool(e.pass),
          changedPixels: num(e.changedPixels),
          totalPixels: num(e.totalPixels),
          changedRatio: num(e.changedRatio),
          width: num(e.width),
          height: num(e.height),
          dimensionsMatch: bool(e.dimensionsMatch),
          baselineWidth: num(e.baselineWidth),
          baselineHeight: num(e.baselineHeight),
          currentWidth: num(e.currentWidth),
          currentHeight: num(e.currentHeight),
          meanDelta: num(e.meanDelta),
          baseline: str(e.baseline),
          current: str(e.current),
          ...(typeof e.diff === 'string' ? { diff: e.diff } : {}),
        });
        return;
      case 'subagent.start':
        v.helper?.({
          phase: 'start',
          id: num(e.id),
          kind: str(e.kind),
          ...(typeof e.agent === 'string' ? { agent: e.agent } : {}),
          description: str(e.description),
        });
        return;
      case 'subagent.finish':
        v.helper?.({
          phase: 'finish',
          id: num(e.id),
          end: str(e.end),
          turns: num(e.turns),
          usd: num(e.usd),
        });
        return;
      case 'tool.start':
        v.line({ kind: 'act', text: str(e.doing) });
        return;
      case 'tool.call':
        if (e.isError)
          v.line({ kind: 'err', text: `  ✗ ${errorLine(str(e.error)).slice(0, 160)}` });
        return;
      case 'agent.thinking': {
        const gist = thinkingGist(str(e.text), this.lastThought);
        if (!gist) return;
        this.lastThought = gist;
        v.line({ kind: 'think', text: gist });
        return;
      }
      case 'todo.update': {
        this.todos = Array.isArray(e.items) ? (e.items as TodoItem[]) : [];
        v.todo(this.todos);
        const left = this.estimator.progress(this.todos, Date.now());
        if (left) v.estimate?.(left);
        return;
      }
      case 'steer.applied':
        v.line({ kind: 'feed', text: 'read your new message' });
        return;
      case 'context.cleared':
        v.line({ kind: 'feed', text: 'trimmed old tool output to keep the context small' });
        return;
      case 'provider.retry':
        v.line({
          kind: 'feed',
          text: `waiting for the model provider (${str(e.error).slice(0, 80)})`,
        });
        return;
      case 'provider.failover':
        v.line({
          kind: 'feed',
          text: `switching from ${str(e.provider)} (${str(e.error).slice(0, 60)})`,
        });
        return;
      default:
    }
  }

  /** One message: the agent works until it replies. */
  async send(
    text: string,
    view: ChatView,
    opts: { plan?: boolean; images?: ContentBlock[] } = {},
  ): Promise<void> {
    const isGreeting = isConversationalGreeting(text) && this.history.length === 0;
    // Plan mode: read-only tools, and the ask goes in the message (the cached prefix is unchanged).
    const baseTools = isGreeting
      ? []
      : opts.plan
        ? this.tools.filter((t) => t.readOnly)
        : this.tools;
    const request = this.effective(baseTools);
    const tools = request.runnable;
    const ask = opts.plan ? `${PLAN_MODE}\n\n${text}` : text;
    this.view = view;
    this.snapshots.push({
      tree: await snapshotTree(this.ctx.jail.root),
      historyLength: this.history.length,
    });
    this.ctx.edited.clear();
    this.ctx.reads?.clear();
    const editsBefore = this.editOps;
    await this.compactIfNeeded();
    const estimate = await this.estimator.start(Boolean(opts.plan), Date.now(), this.telemetry);
    if (estimate) view.estimate?.(estimate);
    let reply: { end: string; text: string };
    const abort = new AbortController();
    this.abort = abort;
    try {
      const deps: LoopDeps = {
        provider: this.provider,
        models: this.models,
        strategy: this.strategy,
        ...(this.paths ? { calibrationFile: tokenCalibrationFile(this.paths) } : {}),
        ...(this.paths
          ? (() => {
              const quota = new QuotaLedger(join(this.paths.configHome, 'quota.json'));
              return {
                modelExhausted: (r: string) => quota.isOut(r),
                markExhausted: (r: string) => {
                  quota.mark(r);
                },
                markRateLimited: (r: string, ms: number) => {
                  quota.mark(r, ms);
                },
              };
            })()
          : {}),
        tools,
        // The turn's signal reaches running commands too, so stop/pause/steer kill them at once.
        toolCtx: { ...this.ctx, signal: abort.signal },
        budget: { ...this.config.budget, max_turns_per_cycle: 200 },
        // A chat turn that circles gets told so once, then stops (it once burned 400k tokens).
        watch: new InCycleWatch(
          {
            repeatedToolCall: this.config.stuck.repeated_tool_call,
            noEditTurns: CHAT_NO_EDIT_TURNS,
            burnTokens: undefined,
          },
          () => this.editOps - editsBefore,
        ),
        watchMode: 'nudge',
        maxTokens: this.config.providers.anthropic.max_tokens,
        clock: realClock,
        events: this.events,
        spentUsd: () => this.usd,
        onUsage: (u, usd, model, provider, meta) => {
          this.usd += usd;
          this.ledger?.recordCall({ ...meta, purpose: 'chat' }, { model, provider, usage: u, usd });
          return Promise.resolve();
        },
        control: () => Promise.resolve(this.paused ? 'pause' : 'continue'),
        pausePollMs: 300,
        signal: abort.signal,
        onDelta: (d) => {
          if (d.text) view.stream(d.text);
        },
        pendingInput: () => this.queue.splice(0),
        onRequest: ({ model, inputTokens }) => {
          const est = estimateLatency(this.latency, model, inputTokens);
          view.waiting?.({ startedAt: Date.now(), estimateMs: est ?? null });
        },
        onResponse: ({ model, inputTokens, ms }) => {
          view.waiting?.(null);
          const m = this.models.find((x) => `${x.provider}:${x.id}` === model);
          this.served = m ? `${m.provider}:${m.alias}` : model;
          this.latency = recordLatency(this.latency, model, { ms, tokens: inputTokens });
          if (this.paths)
            void saveLatency(latencyFile(this.paths), this.latency).catch(() => undefined);
        },
        // Within one long turn only old tool output is trimmed; summaries happen between turns.
        compaction: {
          settings: {
            clearAt: this.config.context.clear_tool_results_at,
            keepToolResults: this.config.context.keep_tool_results,
            compactAt: Number.MAX_SAFE_INTEGER,
            keepTurns: this.config.context.compact_keep_turns,
          },
        },
      };
      let result = await runAgentLoop(
        {
          system: request.system,
          history: this.history,
          first: { role: 'user', content: [{ type: 'text', text: ask }, ...(opts.images ?? [])] },
          tools: request.tools,
        },
        deps,
      );
      // Out of room for this message: summarize, then keep going instead of stopping.
      for (
        let n = 0;
        n < CHAT_CONTINUES && CONTINUE_ENDS.has(result.end) && !abort.signal.aborted;
        n++
      ) {
        this.history = result.messages;
        const summarized = await this.compactForContinue();
        if (!summarized) break;
        view.line({
          kind: 'feed',
          text: 'context was full: summarized the work so far and kept going',
        });
        result = await runAgentLoop(
          {
            system: request.system,
            history: this.history,
            first: { role: 'user', content: [{ type: 'text', text: continuePrompt(text) }] },
            tools: request.tools,
          },
          deps,
        );
      }
      this.history = result.messages;
      reply = { end: result.end, text: result.finalText };
      view.stream('');
      if (result.finalText) view.line({ kind: 'out', text: result.finalText });
      if (result.end === 'stop-now' && this.abortReason === 'pause')
        view.line({ kind: 'feed', text: 'paused. /resume carries on' });
      else if (result.end === 'stop-now' && this.abortReason !== 'steer')
        view.line({ kind: 'feed', text: 'stopped. tell me what to do instead' });
      else if (result.end !== 'done' && result.end !== 'stop-now')
        view.line({ kind: 'err', text: `(stopped: ${result.end})` });
    } finally {
      this.abort = undefined;
      this.abortReason = undefined;
      this.paused = false;
      view.waiting?.(null);
      this.contextUsed = this.baseTokens() + contextTokens(this.history);
    }
    await this.estimator.finish(reply.end === 'done', Date.now(), this.telemetry);
    view.estimate?.(null);
    if (opts.plan && reply.end === 'done')
      this.estimator.planned(reply.text.length, this.todos.length);
    if (this.ctx.edited.size && this.config.gates.length) await this.check(view);
    await this.rememberForRepo();
    await this.persist();
  }

  /**
   * /undo: put the files back as they were before the last message and drop that exchange.
   * Returns the paths restored, or undefined when there is nothing to undo.
   */
  async undo(): Promise<string[] | undefined> {
    const snap = this.snapshots.pop();
    if (!snap) return undefined;
    const touched = snap.tree ? await restoreTree(this.ctx.jail.root, snap.tree) : [];
    this.history = this.history.slice(0, snap.historyLength);
    this.contextUsed = this.baseTokens() + contextTokens(this.history);
    await this.persist();
    return touched;
  }

  /** Save the conversation so `omnexx --continue` can pick it up. */
  private savedChat(): Record<string, unknown> {
    return {
      cwd: this.ctx.jail.root,
      model: this.model,
      savedAt: Date.now(),
      history: this.history,
      ...(this.resumedFrom ? { resumedFrom: this.resumedFrom } : {}),
    };
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.store.file(CHAT_FILE), this.savedChat()).catch(() => undefined);
  }

  /**
   * Before a new chat starts, the conversation so far gets its own History entry; otherwise the
   * next message would overwrite it in this session's chat file.
   */
  private async archiveConversation(): Promise<void> {
    if (!this.paths || !this.history.length) return;
    const dir = join(runsDir(this.paths), newChatId());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(dir, CHAT_FILE), this.savedChat());
  }

  /** Saved chats in this folder, newest first (this one included once it has messages). */
  async savedChats(): Promise<ChatSummary[]> {
    return this.paths ? listChats(this.paths, this.ctx.jail.root) : [];
  }

  /** Reopen a saved chat: its conversation continues here, and History shows it once. */
  async resume(id: string): Promise<Message[]> {
    if (!this.paths) throw new Error('chat history is not available');
    if (this.busy) throw new Error('wait for the agent to finish (or stop it), then switch chats');
    const saved = await readSavedChat(this.paths, this.ctx.jail.root, id);
    await this.clear();
    this.conversation = saved.history;
    this.resumedFrom = id === this.store.runId ? undefined : id;
    await this.persist();
    return saved.history;
  }

  /** Load the newest saved chat for this folder into this one (--continue). Returns its length. */
  async resumeLatest(): Promise<number> {
    if (!this.paths) return 0;
    const dirs = (await readdir(runsDir(this.paths)).catch(() => [] as string[]))
      .filter((d) => d.startsWith('chat_') && d !== this.store.runId)
      .sort()
      .reverse();
    for (const d of dirs) {
      const raw = await readTextOr(join(runsDir(this.paths), d, CHAT_FILE), '');
      if (!raw) continue;
      const saved = JSON.parse(raw) as { cwd?: string; history?: Message[] };
      if (saved.cwd !== this.ctx.jail.root || !saved.history?.length) continue;
      this.conversation = saved.history;
      return saved.history.filter(
        (m) => m.role === 'user' && m.content.some((b) => b.type === 'text'),
      ).length;
    }
    return 0;
  }

  /** Lessons the agent recorded this message become part of the repo's memory. */
  private async rememberForRepo(): Promise<void> {
    if (!this.paths) return;
    this.facts?.promoteNotes(await this.store.readNotes());
    await this.facts?.flush();
    await saveToRepoMemory(
      this.paths,
      this.ctx.jail.root,
      await this.store.readNotes(),
      this.config.context.notes_max_tokens,
    ).catch(() => undefined);
  }

  /** Between messages: trim old tool output, then summarize the oldest exchanges if still big. */
  /**
   * Summarize everything, including the message still being worked on, so the work can go on
   * in a fresh context. False when no summary could be made (then the reply stops as before).
   */
  private async compactForContinue(): Promise<boolean> {
    const summary = await this.summarize(this.history).catch(() => undefined);
    if (!summary) return false;
    const running = (await this.ctx.runningContext?.forPrompt()) ?? '';
    this.history = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Summary of the work so far:\n${summary}${running ? `\n\n${running}` : ''}`,
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood; continuing from there.' }],
      },
    ];
    // The earlier file contents are gone with the summary: reads start fresh.
    this.ctx.reads?.clear();
    this.contextUsed = this.baseTokens() + contextTokens(this.history);
    return true;
  }

  private async compactIfNeeded(
    force = false,
    keepTurns = this.config.context.compact_keep_turns,
  ): Promise<void> {
    const limit = this.config.context.compact_at;
    if (!force && contextTokens(this.history) < this.config.context.clear_tool_results_at) return;
    this.history = trimChatHistory(this.history, this.config.context);
    if (!force && contextTokens(this.history) < limit) return;
    // Keep the last few exchanges verbatim; an exchange starts at a user message with text.
    const starts = this.history.flatMap((m, i) =>
      m.role === 'user' && m.content.some((b) => b.type === 'text') ? [i] : [],
    );
    const cut = starts.at(-Math.max(1, keepTurns));
    if (cut === undefined || cut === 0) {
      this.history = capChatHistory(this.history, this.config.context);
      return;
    }
    const head = this.history.slice(0, cut);
    const summary = await this.summarize(head).catch(() => undefined);
    // Your own running context survives the summary verbatim: it's where the work stands.
    const running = (await this.ctx.runningContext?.forPrompt()) ?? '';
    if (!summary) {
      this.history = capChatHistory(this.history, this.config.context);
      return;
    }
    this.history = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Summary of our conversation so far:\n${summary}${running ? `\n\n${running}` : ''}`,
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood; continuing from there.' }],
      },
      ...this.history.slice(cut),
    ];
    if (!force)
      this.view?.line({
        kind: 'feed',
        text: 'summarized the earlier conversation to free up context',
      });
    this.history = capChatHistory(this.history, this.config.context);
    this.contextUsed = this.baseTokens() + contextTokens(this.history);
  }

  /**
   * /compact and the panel's Compact button: summarize everything but the latest exchange, and
   * always say what happened (it used to do nothing, silently, in a short chat).
   */
  async compact(view: ChatView): Promise<void> {
    this.view = view;
    if (this.busy) {
      view.line({ kind: 'feed', text: 'compact after the agent finishes this message' });
      return;
    }
    const before = contextTokens(this.history);
    const exchanges = this.history.filter(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'text'),
    ).length;
    if (exchanges < 2) {
      view.line({
        kind: 'feed',
        text: `nothing to compact yet: the conversation is one exchange (${kTokens(before)} tokens)`,
      });
      return;
    }
    await this.compactIfNeeded(true, 1);
    this.ctx.reads?.clear();
    const after = contextTokens(this.history);
    view.line({
      kind: 'feed',
      text:
        after < before
          ? `compacted: ${kTokens(before)} → ${kTokens(after)} tokens`
          : `couldn't shrink the conversation (${kTokens(before)} tokens); the summary model may have failed`,
    });
  }

  private async summarize(head: readonly Message[]): Promise<string | undefined> {
    const m = this.models[0];
    if (!m) return undefined;
    const res = await this.provider.complete({
      model: m.id,
      route: m.provider,
      system: [
        { text: 'You compress a coding conversation so it can continue without the transcript.' },
      ],
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Summarize: what the user asked for and decided, what was changed (file paths), what was verified, and what is still open. Concrete and brief.\n\n${this.ctx.redactor.text(transcriptFor(head))}`,
            },
          ],
        },
      ],
      maxTokens: 1_500,
      messageBreakpoints: [],
    });
    const t = res.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n')
      .trim();
    return t || undefined;
  }

  private async check(view: ChatView): Promise<void> {
    view.line({ kind: 'act', text: 'running your checks' });
    const results = await runGates(this.config.gates, {
      ...(this.ctx.exec ? { exec: this.ctx.exec } : {}),
      cwd: this.ctx.jail.root,
      env: this.ctx.env,
      logsDir: this.store.logsDir,
      label: `chat${Date.now()}`,
      maxCmdTimeoutMs: this.ctx.maxCmdTimeoutMs,
      redact: (s) => this.ctx.redactor.text(s),
    });
    const line = results
      .map(
        (r) =>
          `${r.name} ${r.exitCode === 0 ? '✓' : `✗${r.failures.length ? ` (${r.failures.length})` : ''}`}`,
      )
      .join('  ');
    view.line({
      kind: results.every((r) => r.exitCode === 0) ? 'feed' : 'err',
      text: `checks  ${line}`,
    });
  }

  /** Forget the conversation (the codebase map and instructions stay). */
  async clear(): Promise<void> {
    await this.archiveConversation();
    this.resumedFrom = undefined;
    this.history = [];
    this.telemetry = emptyTelemetry();
    this.contextUsed = this.baseTokens();
    // A fresh conversation starts a fresh running context; the old one is kept with the chat.
    await this.ctx.runningContext?.archive();
  }
}
