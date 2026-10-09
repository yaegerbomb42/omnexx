import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCodemap, renderCodemap } from '../agent/codemap.js';
import { clearOldToolResults, contextTokens, transcriptFor } from '../agent/compaction.js';
import { runAgentLoop } from '../agent/loop.js';
import type { CliIO } from '../cli/io.js';
import { resolveRunDeps } from '../cli/run-deps.js';
import type { OmnexxConfig } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { parseDuration } from '../config/duration.js';
import { EventLog, type OmnexxEvent } from '../core/events.js';
import { RunStore } from '../core/run-store.js';
import { RunningContext } from '../core/running-context.js';
import { readTextOr, writeJsonAtomic } from '../core/atomic.js';
import { runsDir } from '../core/paths.js';
import { QuotaLedger } from '../providers/quota-ledger.js';
import { restoreTree, snapshotTree } from './undo.js';
import { renderNotes } from '../core/notes.js';
import type { OmnexxPaths } from '../core/paths.js';
import { readRepoNotes, saveToRepoMemory } from '../core/repo-memory.js';
import { realClock } from '../core/clock.js';
import { estimateTokens } from '../core/tokens.js';
import { loadInstructions, renderInstructions } from '../instructions/load.js';
import type { ResolvedModel } from '../providers/pricing.js';
import { resolveModelLenient } from '../providers/profiles.js';
import type { ContentBlock, Message, Provider } from '../providers/types.js';
import { scrubEnv } from '../security/env-scrub.js';
import { PathJail } from '../security/paths.js';
import { Redactor } from '../security/redact.js';
import { workerTools, toolSpec } from '../tools/registry.js';
import { todoTool, type TodoItem } from '../tools/todo.js';
import type { Tool, ToolContext } from '../tools/types.js';
import { runGates } from '../verify/gates.js';

export const CHAT_SYSTEM = `You are Omnexx in chat mode: a coding agent working turn by turn with a person at the keyboard, directly in their repository (your cwd).

- Do what they ask, then stop and reply briefly: what you changed and what you checked.
- For anything with more than two steps, write a todo list first with the todo tool and keep it current: one item in_progress at a time, done as you finish.
- Before each tool call, say in one short sentence what you are about to do and why.
- Explore with the codebase map, outline, search and ranged reads. Edit with str_replace / multi_edit; write_file for new or small files.
- Run the relevant tests with bash before you finish when you changed code.
- The person may send messages while you work; they arrive marked as such. Read them and adjust at once.
- Some actions need their OK (paths outside the repo, commands the policy refuses); they are asked for you. If they say no, find another way or explain.
- Ask a question instead of guessing when the request is ambiguous and the choice matters.`;

/** Prepended to a message in plan mode. */
const PLAN_MODE = `[Plan mode] Don't change anything yet: no edits and no commands. Investigate with the read-only tools, then reply with a concrete step-by-step plan: the files to change and how, the approach, how you will test it, and any risks or questions for me. Put the steps in the todo list. Stop after the plan; I'll approve it or ask for changes.`;

/** Where a chat's conversation is saved, inside its store. */
const CHAT_FILE = 'chat.json';

/** Tools chat leaves out: helpers need a run. */
const CHAT_DENIED = new Set(['task']);

/** What the chat shows the person. */
export type ChatLine =
  | { kind: 'act'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'out'; text: string }
  | { kind: 'feed'; text: string }
  | { kind: 'err'; text: string };

export interface ChatView {
  line: (l: ChatLine) => void;
  /** Reply text as it streams in (cleared when the reply lands as an `out` line). */
  stream: (delta: string) => void;
  todo: (items: TodoItem[]) => void;
}

const firstLine = (t: string): string =>
  t
    .split('\n')
    .find((l) => l.trim())
    ?.trim() ?? '';

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
export class CodeChat {
  private history: Message[] = [];
  /** Set by open(); where repo memory lives. */
  paths: OmnexxPaths | undefined;
  /** Before each message: the files as they were, and how long the conversation was. */
  private snapshots: { tree: string | undefined; historyLength: number }[] = [];
  private queue: string[] = [];
  private abort: AbortController | undefined;
  private view: ChatView | undefined;
  private models: ResolvedModel[];
  usd = 0;
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
    this.models = (typeof refs === 'string' ? [refs] : refs).map((r) => chatModel(r, config));
    this.contextUsed = this.baseTokens();
    // One listener for the whole chat: every action shows as a line while it happens.
    events.onEvent((e) => {
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
    const store = new RunStore(
      paths,
      `chat_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`,
    );
    await mkdir(store.logsDir, { recursive: true, mode: 0o700 });
    const redactor = Redactor.fromEnv(io.env, deps.secrets);
    const clock = io.clock ?? realClock;
    const events = new EventLog(store.eventsPath, store.runId, redactor, clock);
    const tmp = join('/tmp', `omnexx-${store.runId}`);
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const jail = new PathJail(io.cwd);
    let n = 0;
    const ctx: ToolContext = {
      jail,
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
    const tools = [
      ...(await workerTools(config, { repoRoot: jail.root, env: io.env })).filter(
        (t) => !CHAT_DENIED.has(t.name),
      ),
      todoTool as Tool,
    ];
    const instructions = renderInstructions(await loadInstructions(jail.root, jail.root));
    const codemap = renderCodemap(
      await buildCodemap(jail.root),
      config.context.repo_map_max_tokens,
    );
    // What earlier runs and chats learned about this repo; the remember tool adds to it.
    const known = await readRepoNotes(paths, jail.root);
    if (known.length) await store.writeNotes(known);
    const system = [
      { text: CHAT_SYSTEM },
      ...(instructions ? [{ text: instructions }] : []),
      ...(known.length ? [{ text: `# Lessons about this repo\n\n${renderNotes(known)}` }] : []),
      { text: codemap, cacheBreakpoint: true },
    ];
    const chat = new CodeChat(config, deps.provider, tools, system, ctx, events, store, ref);
    chat.paths = paths;
    return chat;
  }

  /** "provider:model" of the model chat talks to. */
  get model(): string {
    const m = this.models[0];
    return m ? `${m.provider}:${m.alias}` : '?';
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

  /** A message typed while the agent works: it joins the conversation at the next step. */
  steer(text: string): void {
    this.queue.push(text);
  }

  /** Messages that arrived after the agent's last step: the session sends them next. */
  takeLeftovers(): string[] {
    return this.queue.splice(0);
  }

  /** /pause: hold at the next step boundary until resume() (the loop polls control()). */
  paused = false;

  /** Esc: end the current turn, keeping every completed step. */
  interrupt(): void {
    this.abort?.abort();
  }

  /** The context limit the chat compacts at. */
  get contextLimit(): number {
    return this.config.context.compact_at;
  }

  private baseTokens(): number {
    return estimateTokens(JSON.stringify([this.system, this.tools.map(toolSpec)]));
  }

  private onEvent(e: OmnexxEvent): void {
    const v = this.view;
    if (!v) return;
    const str = (x: unknown): string => (typeof x === 'string' ? x : '');
    switch (e.type) {
      case 'tool.start':
        v.line({ kind: 'act', text: str(e.doing) });
        return;
      case 'tool.call':
        if (e.isError)
          v.line({ kind: 'err', text: `  ✗ ${errorLine(str(e.error)).slice(0, 160)}` });
        return;
      case 'agent.thinking':
        v.line({ kind: 'think', text: firstLine(str(e.text)).slice(0, 200) });
        return;
      case 'todo.update':
        v.todo(Array.isArray(e.items) ? (e.items as TodoItem[]) : []);
        return;
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
    // Plan mode: read-only tools, and the ask goes in the message (the cached prefix is unchanged).
    const tools = opts.plan ? this.tools.filter((t) => t.readOnly) : this.tools;
    const ask = opts.plan ? `${PLAN_MODE}\n\n${text}` : text;
    this.view = view;
    this.snapshots.push({
      tree: await snapshotTree(this.ctx.jail.root),
      historyLength: this.history.length,
    });
    this.ctx.edited.clear();
    this.ctx.reads?.clear();
    await this.compactIfNeeded();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const result = await runAgentLoop(
        {
          system: this.system,
          history: this.history,
          first: { role: 'user', content: [{ type: 'text', text: ask }, ...(opts.images ?? [])] },
          tools: tools.map(toolSpec),
        },
        {
          provider: this.provider,
          models: this.models,
          ...(this.paths
            ? (() => {
                const quota = new QuotaLedger(join(this.paths.configHome, 'quota.json'));
                return {
                  modelExhausted: (r: string) => quota.exhaustedAt(r) !== undefined,
                  markExhausted: (r: string) => {
                    quota.mark(r);
                  },
                };
              })()
            : {}),
          tools,
          toolCtx: this.ctx,
          budget: { ...this.config.budget, max_turns_per_cycle: 200 },
          maxTokens: this.config.providers.anthropic.max_tokens,
          clock: realClock,
          events: this.events,
          spentUsd: () => this.usd,
          onUsage: (_u, usd) => {
            this.usd += usd;
            return Promise.resolve();
          },
          control: () => Promise.resolve(this.paused ? 'pause' : 'continue'),
          pausePollMs: 300,
          signal: abort.signal,
          onDelta: (d) => {
            if (d.text) view.stream(d.text);
          },
          pendingInput: () => this.queue.splice(0),
          // Within one long turn only old tool output is trimmed; summaries happen between turns.
          compaction: {
            settings: {
              clearAt: this.config.context.clear_tool_results_at,
              keepToolResults: this.config.context.keep_tool_results,
              compactAt: Number.MAX_SAFE_INTEGER,
              keepTurns: this.config.context.compact_keep_turns,
            },
          },
        },
      );
      this.history = result.messages;
      view.stream('');
      if (result.finalText) view.line({ kind: 'out', text: result.finalText });
      if (result.end === 'stop-now')
        view.line({ kind: 'feed', text: 'stopped. tell me what to do instead' });
      else if (result.end !== 'done') view.line({ kind: 'err', text: `(stopped: ${result.end})` });
    } finally {
      this.abort = undefined;
      this.paused = false;
      this.contextUsed = this.baseTokens() + contextTokens(this.history);
    }
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
  private async persist(): Promise<void> {
    await writeJsonAtomic(this.store.file(CHAT_FILE), {
      cwd: this.ctx.jail.root,
      model: this.model,
      savedAt: Date.now(),
      history: this.history,
    }).catch(() => undefined);
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
    await saveToRepoMemory(
      this.paths,
      this.ctx.jail.root,
      await this.store.readNotes(),
      this.config.context.notes_max_tokens,
    ).catch(() => undefined);
  }

  /** Between messages: trim old tool output, then summarize the oldest exchanges if still big. */
  private async compactIfNeeded(force = false): Promise<void> {
    const limit = this.config.context.compact_at;
    if (!force && contextTokens(this.history) < this.config.context.clear_tool_results_at) return;
    this.history = clearOldToolResults(
      this.history,
      this.config.context.keep_tool_results,
    ).messages;
    if (!force && contextTokens(this.history) < limit) return;
    // Keep the last few exchanges verbatim; an exchange starts at a user message with text.
    const starts = this.history.flatMap((m, i) =>
      m.role === 'user' && m.content.some((b) => b.type === 'text') ? [i] : [],
    );
    const cut = starts.at(-Math.max(1, this.config.context.compact_keep_turns));
    if (cut === undefined || cut === 0) return;
    const head = this.history.slice(0, cut);
    const summary = await this.summarize(head).catch(() => undefined);
    // Your own running context survives the summary verbatim: it's where the work stands.
    const running = (await this.ctx.runningContext?.forPrompt()) ?? '';
    if (!summary) return;
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
    this.view?.line({
      kind: 'feed',
      text: 'summarized the earlier conversation to free up context',
    });
    this.contextUsed = this.baseTokens() + contextTokens(this.history);
  }

  /** /compact. */
  async compact(view: ChatView): Promise<void> {
    this.view = view;
    await this.compactIfNeeded(true);
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
  clear(): void {
    this.history = [];
    this.contextUsed = this.baseTokens();
    // A fresh conversation starts a fresh running context; the old one is kept with the chat.
    void this.ctx.runningContext?.archive();
  }
}
