import { join } from 'node:path';
import { Writable } from 'node:stream';
import { parse } from 'shell-quote';
import { brand, type Brand } from '../cli/brand.js';
import type { CliIO } from '../cli/io.js';
import { pickRun, supervisorAlive } from '../cli/commands/control.js';
import { steerRun } from '../cli/commands/steer.js';
import { git } from '../git/git.js';
import {
  connect,
  connectFromEnv,
  describeConnect,
  envKeys,
  findKeyInText,
  looksLikeKey,
  type EnvKey,
} from '../cli/connect.js';
import { maskKey } from '../auth/keys.js';
import { Chat, defaultChatRef, hasProvider } from './chat.js';
import { CodeChat, type ChatLine } from './code-chat.js';
import type { TodoItem } from '../tools/todo.js';
import { classifyMarkdown, type MdKind } from './markdown.js';
import { parseDiff, type DiffViewState } from './diff.js';
import { loadAgents, type AgentsState } from './agents.js';
import { attachImages } from './attach.js';
import { commandDirs, expandCommand, loadCustomCommands, type CustomCommand } from './commands.js';
import type { Mood } from './mascot.js';
import {
  filterChoices,
  loadModelChoices,
  type ModelPickerState,
  type RankState,
} from './model-picker.js';
import {
  POOL_MODES,
  readPoolMode,
  readRanking,
  writePoolMode,
  writeRanking,
} from '../config/ranking.js';
import { QuotaLedger } from '../providers/quota-ledger.js';
import { compactPlanView, planCounts } from '../core/plan.js';
import { resolvePaths } from '../core/paths.js';
import { listRunIds, RunStore } from '../core/run-store.js';
import { describeError } from '../errors.js';
import { emptyTelemetry, fold, type Telemetry } from '../telemetry/aggregate.js';
import { EventTail } from '../telemetry/feed.js';
import { humanize, type Verbosity } from '../telemetry/humanize.js';

export type EntryKind = 'feed' | 'out' | 'err' | 'user' | 'system' | 'act' | 'think';
export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
  /** Model replies render as markdown, line by line. */
  md?: MdKind;
}

export type RunCli = (argv: readonly string[], io: CliIO) => Promise<number>;

export interface SlashCommand {
  name: string;
  args?: string;
  help: string;
}

/** Built-in slash commands; anything else after `/` runs the CLI command of that name. */
export const SLASH: readonly SlashCommand[] = [
  {
    name: 'model',
    args: '[model|url|key]',
    help: 'pick the chat model, or add an API key or endpoint',
  },
  {
    name: 'models',
    help: 'your model pool: tick models, pick top-first or random, each runs until its quota is out',
  },
  { name: 'agents', help: 'every long run on this machine: watch, attach, pause, stop' },
  { name: 'pause', help: 'pause the agent after its current step (/resume to continue)' },
  { name: 'resume', help: 'continue where the agent paused' },
  { name: 'stop', help: 'stop the agent now (same as esc)' },
  { name: 'diff', help: 'browse what changed' },
  { name: 'go', help: 'plan mode: approve the plan and carry it out' },
  { name: 'undo', help: 'put the files back as they were before the last message' },
  { name: 'compact', help: 'summarize the conversation to free up context' },
  { name: 'clear', help: 'start a fresh conversation' },
  { name: 'help', help: 'this list' },
  { name: 'quit', help: 'leave omnexx (a long run keeps going)' },
];

/** Still work when typed, but kept out of the menu: long-run plumbing and rarely needed tools. */
export const MORE_SLASH = [
  'run <goal>',
  'plan',
  'status',
  'report',
  'runs',
  'attach',
  'detach',
  'steer',
  'connect',
  'setup',
  'init',
  'doctor',
];

export type Mode = 'chat' | 'plan' | 'run';

const MODE_INTRO: Record<Mode, string> = {
  chat: 'chat mode: each message is worked on right here in your checkout; checks run after edits',
  plan: 'plan mode: the agent investigates and proposes a plan without changing anything; /go to carry it out',
  run: 'run mode: your text starts a long run, or steers the live one',
};

const NEXT_MODE: Record<Mode, Mode> = { chat: 'plan', plan: 'run', run: 'chat' };

/** Commands that never return or need the real terminal. */
const BLOCKED = new Set(['supervise', 'service']);
const MAX_ENTRIES = 5_000;

/**
 * Everything the TUI does, without React: a transcript of entries, the attached run's live
 * telemetry and plan, and slash commands that reuse the real CLI with its output captured.
 */
const POOL_LABEL = { ordered: 'top first', random: 'random order', smart: 'Nimble picks' } as const;

export class Session {
  entries: Entry[] = [];
  telemetry: Telemetry = emptyTelemetry();
  runId: string | undefined;
  runAlive = false;
  plan = '';
  /** Phase and task progress of the attached run, refreshed with the plan. */
  info: { phase: string; done: number; tasks: number } | undefined;
  busy: string | undefined;
  verbosity: Verbosity = 'normal';
  quit = false;
  chat: Chat | undefined;
  /** What plain text does: start or steer a long run, or code turn by turn. */
  mode: Mode = 'chat';
  /** A y/n question from chat mode waiting on the person (permission to go past a guard). */
  pending: { question: string; resolve: (yes: boolean) => void } | undefined;
  private code: CodeChat | undefined;
  private opening: Promise<CodeChat> | undefined;
  /** Model chosen with /model before the chat opened. */
  private chatModel: string | undefined;
  /** The chat reply as it streams in; moves into the transcript when it lands. */
  live = '';
  /** The agent's checklist for the current request (the todo tool). */
  todos: TodoItem[] = [];
  /** OMNEXX_NO_MASCOT=1 hides the animated character. */
  readonly mascot: boolean;
  readonly history: string[] = [];

  private nextId = 0;
  private tail: EventTail | undefined;
  private listeners = new Set<() => void>();
  private lastPlanAt = 0;
  private readonly b: Brand;

  constructor(
    private readonly io: CliIO,
    private readonly runCli: RunCli,
    private readonly now: () => number = Date.now,
  ) {
    this.b = brand({ env: io.env, isTTY: true });
    this.mascot = !io.env.OMNEXX_NO_MASCOT;
    this.nex = { mood: 'hello', at: now(), say: '' };
    this.lastActivity = now();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** `markdown` marks a model's reply; command output (diffs, logs) is never reinterpreted. */
  push(kind: EntryKind, text: string, opts: { markdown?: boolean } = {}): void {
    const lines = text.replace(/\n$/, '').split('\n');
    const md = opts.markdown ? classifyMarkdown(lines) : undefined;
    for (const [i, line] of lines.entries()) {
      const m = md?.[i];
      this.entries.push({ id: this.nextId++, kind, text: line, ...(m ? { md: m } : {}) });
    }
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    this.changed();
  }

  /** First-run hint: with no provider set up, say how to add one before anything else. */
  async greet(firstRun = false): Promise<void> {
    const ready = await hasProvider(this.io).catch(() => true);
    if (ready && !firstRun) return;
    const found = await envKeys(this.io).catch(() => [] as EnvKey[]);
    const model = ready
      ? ['1. a model: you have one. /model to switch or add more, /models to rank them']
      : [
          '1. a model (pick any):',
          ...(found.length
            ? [
                `     /connect env      use the keys already in your environment: ${found.map((k) => k.label).join(', ')}`,
              ]
            : []),
          '     paste an API key  OpenAI, Gemini, xAI, Groq, OpenRouter, Mistral, NVIDIA, … are recognised',
          '     /connect ollama   a free local model (also lmstudio, vllm, llamacpp, jan)',
          '     /model            browse providers, or add any OpenAI-compatible URL',
        ];
    this.push(
      'system',
      [
        firstRun
          ? 'welcome to omnexx: an agent that works in this folder and keeps going until your checks pass'
          : 'no model set up yet',
        '',
        ...model,
        '2. ask: type what you want built or fixed. shift+tab: plan first, or a long unattended run',
        '3. review: /diff shows what changed, /undo takes it back, /help lists everything',
      ].join('\n'),
    );
  }

  /** Attach to the newest run if its supervisor is still alive (reopening the TUI mid-run). */
  async resumeLatest(): Promise<void> {
    const ids = await listRunIds(resolvePaths(this.io.env));
    const id = ids.at(-1);
    if (!id) return;
    if (await supervisorAlive(new RunStore(resolvePaths(this.io.env), id))) await this.attach(id);
  }

  async attach(runId?: string): Promise<void> {
    const store = await pickRun(resolvePaths(this.io.env), runId);
    this.runId = store.runId;
    this.tail = new EventTail(store.eventsPath);
    this.telemetry = emptyTelemetry();
    this.plan = '';
    this.lastPlanAt = 0;
    this.push('system', `attached to ${store.runId}`);
    await this.poll();
  }

  detach(): void {
    if (!this.runId) return;
    this.push(
      'system',
      `detached from ${this.runId}; it keeps running (\`omnexx watch\` to return)`,
    );
    this.runId = undefined;
    this.tail = undefined;
    this.runAlive = false;
    this.plan = '';
    this.changed();
  }

  /** Pull new events into the feed and refresh liveness and the plan (every ~2 s). */
  async poll(): Promise<void> {
    if (!this.tail || !this.runId) return;
    const events = await this.tail.read();
    for (const e of events) {
      fold(this.telemetry, e);
      const line = humanize(e, { brand: this.b, verbosity: this.verbosity });
      if (line) this.push('feed', line);
    }
    if (this.now() - this.lastPlanAt > 2_000) {
      this.lastPlanAt = this.now();
      const store = new RunStore(resolvePaths(this.io.env), this.runId);
      this.runAlive = await supervisorAlive(store);
      const [plan, state] = await Promise.all([
        store.readPlan().catch(() => undefined),
        store.readState().catch(() => undefined),
      ]);
      this.plan = plan ? compactPlanView(plan, state?.taskId) : '';
      const c = plan ? planCounts(plan) : undefined;
      this.info = state
        ? { phase: state.phase, done: c?.done ?? 0, tasks: c?.tasks ?? 0 }
        : undefined;
      this.changed();
    } else if (events.length) {
      this.changed();
    }
  }

  /** Run a CLI command with its output captured into the transcript. */
  async cli(
    argv: readonly string[],
    label = argv.join(' '),
  ): Promise<{ code: number; out: string }> {
    let out = '';
    const sink = (kind: EntryKind): Writable =>
      new Writable({
        write: (chunk: Buffer | string, _enc, cb) => {
          const s = chunk.toString();
          if (kind === 'out') out += s;
          this.push(kind, s);
          cb();
        },
      });
    const captured: CliIO = { ...this.io, stdout: sink('out'), stderr: sink('err'), isTTY: false };
    this.busy = label;
    this.changed();
    try {
      const code = await this.runCli(argv, captured);
      return { code, out };
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  /** Plain text starts a run, or steers the attached live run. `/x` is a command. */
  async submit(raw: string): Promise<void> {
    const text = raw.trim();
    const pending = this.pending;
    if (pending) {
      const yes = /^y(es)?$/i.test(text);
      this.pending = undefined;
      this.push('system', `${yes ? 'allowed' : 'refused'}: ${pending.question}`);
      pending.resolve(yes);
      return;
    }
    if (!text) return;
    const awaiting = this.awaiting;
    if (awaiting) {
      // The picker asked for a key or endpoint: connect it, then show its models.
      this.awaiting = undefined;
      const words = text.split(/\s+/);
      const at = words.indexOf('--name');
      const name = at >= 0 ? words[at + 1] : undefined;
      const rest = at >= 0 ? words.filter((_, i) => i !== at && i !== at + 1) : words;
      this.push('user', awaiting === 'key' ? maskKey(text) : text.replace(/\s(\S{20,})/, ' ••••'));
      try {
        await this.connect(rest[0] ?? '', rest[1], name);
        await this.openModelPicker();
      } catch (err) {
        this.push('err', describeError(err));
      }
      return;
    }
    // A key inside a sentence ("my groq key is gsk_…"): connect it, and keep it out of the chat.
    const found = !text.startsWith('/') && !looksLikeKey(text) ? findKeyInText(text) : undefined;
    if (found) {
      this.push('user', text.replace(found.key, maskKey(found.key)));
      if (found.provider)
        await this.connect(found.provider, found.key).catch((err: unknown) => {
          this.push('err', describeError(err));
        });
      else {
        this.pendingKey = found.key;
        this.push(
          'system',
          `that looks like an API key. which provider is it for? (e.g. ${['mistral', 'together', 'deepinfra'].join(', ')}; /providers lists all)`,
        );
      }
      return;
    }
    if (this.pendingKey && /^[a-z][a-z0-9_-]*$/i.test(text.trim())) {
      const key = this.pendingKey;
      this.pendingKey = undefined;
      this.push('user', text);
      await this.connect(text.trim().toLowerCase(), key).catch((err: unknown) => {
        this.push('err', describeError(err));
      });
      return;
    }
    this.pendingKey = undefined;
    // A pasted key is never echoed, kept in history, or sent anywhere but the credentials file.
    const key = looksLikeKey(text);
    if (!key) this.history.push(text);
    this.push('user', key ? maskKey(text) : this.chat ? this.chat.redact(text) : text);
    try {
      if (text.startsWith('/')) await this.slash(text.slice(1));
      else if (key && !this.chat) await this.connect(text);
      else if (this.chat) await this.talk(text);
      else if (this.mode === 'chat' || this.mode === 'plan') await this.code_(text);
      else if (this.runId && this.runAlive) await this.steer(text);
      else await this.startRun(text);
    } catch (err) {
      this.push('err', describeError(err));
    }
  }

  private async connect(target: string, key?: string, name?: string): Promise<void> {
    this.busy = 'connecting';
    this.changed();
    try {
      this.push(
        'system',
        describeConnect(await connect(this.io, target, key, name ? { name } : {})),
      );
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  private async talk(text: string): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    this.busy = chat.ref;
    this.changed();
    try {
      await chat.send(text, (line) => {
        this.push('out', line, { markdown: true });
      });
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  /** Chat mode asks the person before going past a guard; the TUI shows it above the input. */
  ask(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending = { question, resolve };
      this.changed();
    });
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.push('system', MODE_INTRO[mode]);
  }

  /** shift+tab: chat → plan → run → chat. */
  nextMode(): void {
    this.setMode(NEXT_MODE[this.mode]);
  }

  /** Nex's latest reaction and what it says; the TUI turns this into a mood each tick. */
  nex: { mood: Mood; at: number; say: string } = { mood: 'hello', at: 0, say: '' };
  /** The last time anything happened (typing, output), for Nex dozing off. */
  lastActivity = 0;

  react(mood: Mood, say = ''): void {
    this.nex = { mood, at: this.now(), say };
    this.lastActivity = this.now();
  }

  /** The person is typing: Nex wakes up and listens. */
  touch(): void {
    this.lastActivity = this.now();
  }

  /** The open /model picker; it takes over the keys until closed. */
  modelPicker: ModelPickerState | undefined;
  /** The picker asked for a key or URL: the next message is that, not a chat message. */
  awaiting: 'key' | 'url' | undefined;

  /** A key found without a provider name: the next one-word message names its provider. */
  private pendingKey: string | undefined;

  /** The open /models ranking editor. */
  rankView: RankState | undefined;
  /** What choosing in the picker does: switch chat, or add to the ranking. */
  private pickFor: 'chat' | 'rank' = 'chat';

  async openRanking(): Promise<void> {
    this.rankView = await this.rankState(0);
    this.changed();
  }

  private async rankState(cursor: number): Promise<RankState> {
    const paths = resolvePaths(this.io.env);
    const ranked = await readRanking(paths);
    const out = new QuotaLedger(join(paths.configHome, 'quota.json')).all();
    return {
      ranked,
      mode: await readPoolMode(paths),
      exhausted: new Set(Object.keys(out)),
      cursor: Math.min(cursor, Math.max(0, ranked.length - 1)),
      grabbed: false,
    };
  }

  /** Keys while the ranking editor is open; every change is saved to models.json at once. */
  async rankKey(k: {
    up?: boolean;
    down?: boolean;
    grab?: boolean;
    add?: boolean;
    remove?: boolean;
    mode?: boolean;
    close?: boolean;
  }): Promise<void> {
    const v = this.rankView;
    if (!v) return;
    const move = (d: number): void => {
      const to = v.cursor + d;
      if (to < 0 || to >= v.ranked.length) return;
      if (v.grabbed) {
        const [it] = v.ranked.splice(v.cursor, 1);
        if (it) v.ranked.splice(to, 0, it);
      }
      v.cursor = to;
    };
    if (k.close) {
      this.rankView = undefined;
      this.push(
        'system',
        v.ranked.length
          ? `pool saved (${POOL_LABEL[v.mode]}): ${v.ranked.map((r, i) => `${i + 1}. ${r}`).join('  ')}. new chats and runs use it; /model switches this chat`
          : 'no ranking: roles use your config.toml models',
      );
    } else if (k.up) move(-1);
    else if (k.down) move(1);
    else if (k.mode) {
      v.mode = POOL_MODES[(POOL_MODES.indexOf(v.mode) + 1) % POOL_MODES.length] ?? 'ordered';
      await writePoolMode(resolvePaths(this.io.env), v.mode);
    } else if (k.grab) v.grabbed = !v.grabbed && v.ranked.length > 0;
    else if (k.remove) {
      v.ranked.splice(v.cursor, 1);
      v.cursor = Math.max(0, Math.min(v.cursor, v.ranked.length - 1));
      v.grabbed = false;
    } else if (k.add) {
      this.rankView = undefined;
      this.pickFor = 'rank';
      await this.openModelPicker();
      return;
    }
    await writeRanking(resolvePaths(this.io.env), v.ranked);
    this.changed();
  }

  async openModelPicker(): Promise<void> {
    this.busy = 'listing models';
    this.changed();
    try {
      const { items, unreachable } = await loadModelChoices(this.io);
      this.modelPicker = {
        items,
        unreachable,
        query: '',
        cursor: 0,
        current: this.chatModelName,
        ...(this.pickFor === 'rank' ? { checked: new Set<string>() } : {}),
      };
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  /** Keys while the picker is open. */
  pickerKey(k: {
    up?: boolean;
    down?: boolean;
    enter?: boolean;
    close?: boolean;
    back?: boolean;
    toggle?: boolean;
    char?: string;
  }): void {
    const p = this.modelPicker;
    if (!p) return;
    const shown = filterChoices(p.items, p.query);
    if (k.close) {
      this.modelPicker = undefined;
      if (this.pickFor === 'rank') {
        this.pickFor = 'chat';
        void this.openRanking();
      }
    } else if (k.up) p.cursor = Math.max(0, p.cursor - 1);
    else if (k.down) p.cursor = Math.min(shown.length - 1, p.cursor + 1);
    else if (k.toggle && p.checked) {
      const it = shown[Math.min(p.cursor, shown.length - 1)];
      if (it?.kind === 'model') {
        if (p.checked.has(it.ref)) p.checked.delete(it.ref);
        else p.checked.add(it.ref);
        p.cursor = Math.min(shown.length - 1, p.cursor + 1);
      }
    } else if (k.back) {
      p.query = p.query.slice(0, -1);
      p.cursor = 0;
    } else if (k.char) {
      p.query += k.char;
      p.cursor = 0;
    } else if (k.enter) {
      const it = shown[Math.min(p.cursor, shown.length - 1)];
      this.modelPicker = undefined;
      if (it?.kind === 'model' && this.pickFor === 'rank') {
        // Picked for the pool: append the ticked models (or this one) and go back to the editor.
        this.pickFor = 'chat';
        const add = p.checked?.size ? [...p.checked] : [it.ref];
        void (async () => {
          const paths = resolvePaths(this.io.env);
          const ranked = await readRanking(paths);
          for (const r of add) if (!ranked.includes(r)) ranked.push(r);
          await writeRanking(paths, ranked);
          this.rankView = await this.rankState(ranked.length - 1);
          this.changed();
        })();
      } else if (it?.kind === 'model')
        void this.switchModel(it.ref).catch((err: unknown) => {
          this.push('err', describeError(err));
        });
      else if (it?.kind === 'add-env')
        void this.slash('connect env').catch((err: unknown) => {
          this.push('err', describeError(err));
        });
      else if (it?.kind === 'add-key') {
        this.awaiting = 'key';
        this.push(
          'system',
          'paste the API key and press enter (it is saved to a 0600 file, never shown)',
        );
      } else if (it?.kind === 'add-url') {
        this.awaiting = 'url';
        this.push(
          'system',
          'enter the endpoint: <url> [key] [--name alias], e.g. http://localhost:11434/v1 --name local',
        );
      }
    }
    this.changed();
  }

  /** Switch chat to `ref`, keeping the conversation. */
  async switchModel(ref: string): Promise<void> {
    if (this.code?.busy) throw new Error('wait for the agent to finish (or esc), then switch');
    this.chatModel = ref;
    if (this.code) {
      // A model on another endpoint needs its own client: reopen, keep the conversation.
      const history = this.code.conversation;
      this.code = undefined;
      (await this.openCode()).conversation = history;
    }
    this.push('system', `chat model: ${ref}`);
    this.react('happy', `hello from ${ref.split(':').pop() ?? ref}!`);
  }

  /** Context in use / the limit chat compacts at, once a chat is open. */
  get context(): { used: number; limit: number } | undefined {
    return this.code ? { used: this.code.contextUsed, limit: this.code.contextLimit } : undefined;
  }

  get chatModelName(): string | undefined {
    return this.code?.model ?? this.chatModel;
  }

  /** `omnexx --continue`: open chat with the last conversation in this folder. */
  async continueChat(): Promise<void> {
    try {
      const code = await this.openCode();
      const n = await code.resumeLatest();
      this.push(
        'system',
        n
          ? `continuing your last chat here (${n} message${n === 1 ? '' : 's'})`
          : 'no earlier chat in this folder; starting fresh',
      );
    } catch (err) {
      this.push('err', describeError(err));
    }
  }

  /** Esc: stop the agent's current turn. Returns false when nothing was running. */
  interrupt(): boolean {
    if (!this.code?.busy) return false;
    this.code.interrupt();
    this.react('startled');
    this.push('system', 'stopping…');
    return true;
  }

  private async openCode(): Promise<CodeChat> {
    if (this.code) return this.code;
    this.opening ??= CodeChat.open(this.io, (q) => this.ask(q), this.chatModel);
    try {
      this.code = await this.opening;
      return this.code;
    } finally {
      this.opening = undefined;
    }
  }

  private readonly view = {
    line: (l: ChatLine) => {
      this.push(l.kind, l.text, { markdown: l.kind === 'out' });
      if (l.kind === 'act') this.nex = { mood: 'working', at: 0, say: `${l.text}!` };
      else if (l.kind === 'err') this.react('sad', l.text.includes('✗') ? 'hm, that failed' : '');
      else if (l.kind === 'feed' && l.text.startsWith('checks'))
        this.react(
          l.text.includes('✗') ? 'sad' : 'happy',
          l.text.includes('✗') ? 'checks failed' : 'checks pass!',
        );
      else if (l.kind === 'out') this.react('happy', 'done!');
      this.lastActivity = this.now();
    },
    stream: (delta: string) => {
      this.live = delta ? this.live + delta : '';
      this.changed();
    },
    todo: (items: TodoItem[]) => {
      this.todos = items;
      this.changed();
    },
  };

  private async code_(text: string): Promise<void> {
    // While the agent works, a new message goes straight to it, read at its next step.
    if (this.code?.busy) {
      this.code.steer(text);
      this.push('system', 'sent to the agent; it reads this at its next step');
      return;
    }
    this.busy = 'working';
    this.changed();
    try {
      let code: CodeChat;
      try {
        code = await this.openCode();
      } catch (err) {
        // No model set up yet: say how, and open the picker, instead of a raw key error.
        if (!/API key|needs [A-Z_]+|no provider/i.test(describeError(err))) throw err;
        this.push(
          'system',
          'no model set up yet: pick one below, paste an API key, or add your own endpoint',
        );
        await this.openModelPicker();
        return;
      }
      let next: string | undefined = text;
      while (next !== undefined) {
        // Images the message points at (dragged-in paths) go to the model with it.
        const att = await attachImages(next, this.io.cwd);
        if (att.attached.length) this.push('system', `attached ${att.attached.join(', ')}`);
        if (att.skipped.length) this.push('system', `not attached: ${att.skipped.join(', ')}`);
        await code.send(next, this.view, {
          plan: this.mode === 'plan',
          ...(att.blocks.length ? { images: att.blocks } : {}),
        });
        // Messages that arrived after its last step: answer them now, not never.
        const left = code.takeLeftovers();
        next = left.length ? left.join('\n') : undefined;
      }
      if (code.usd > 0) this.push('system', `chat spend $${code.usd.toFixed(2)}`);
      if (this.mode === 'plan')
        this.push('system', 'plan ready: /go to carry it out, or type what to change');
    } finally {
      this.busy = undefined;
      this.live = '';
      this.changed();
    }
  }

  private async openChat(arg: string): Promise<void> {
    if (arg === 'off') {
      this.chat = undefined;
      this.push('system', 'setup chat off');
      return;
    }
    const ref = arg || (await defaultChatRef(this.io));
    if (!ref)
      throw new Error(
        'no provider set up yet: paste an API key, or /connect ollama (or any URL) first',
      );
    this.chat = await Chat.open(this.io, ref);
    this.push(
      'system',
      `talking to ${ref} about providers. e.g. "connect my groq key". /setup off to leave`,
    );
  }

  private async steer(text: string): Promise<void> {
    const id = await steerRun(this.io, this.runId, text, this.now());
    this.push('system', `steering note added to ${id}; it applies from the next cycle`);
  }

  private async startRun(goal: string): Promise<void> {
    const { code, out } = await this.cli(['run', '--detach', goal], 'starting run');
    const id = out
      .split('\n')
      .find((l) => /^\S+$/.test(l.trim()))
      ?.trim();
    if (code === 0 && id) await this.attach(id);
  }

  private async slash(line: string): Promise<void> {
    const words = parse(line).filter((w): w is string => typeof w === 'string');
    const [cmd = '', ...args] = words;
    const rest = line.slice(cmd.length).trim();
    switch (cmd) {
      case 'help':
        this.push('system', helpText(this.b));
        if (this.custom.length)
          this.push(
            'system',
            [
              'your commands',
              ...this.custom.map((c) => `  /${c.name}  ${c.description}  (${c.source})`),
            ].join('\n'),
          );
        return;
      case 'quit':
      case 'exit':
        this.quit = true;
        this.changed();
        return;
      case 'run':
        if (rest) await this.startRun(rest);
        else this.setMode('run');
        return;
      case 'plan':
        if (rest) await this.cli(['run', '--plan-only', rest], 'planning');
        else await this.cli(['plan', ...(this.runId ? [this.runId] : [])]);
        return;
      case 'steer':
        await this.steer(rest);
        return;
      case 'attach':
      case 'watch':
        await this.attach(args[0]);
        return;
      case 'detach':
        this.detach();
        return;
      case 'quiet':
      case 'normal':
      case 'verbose':
        this.verbosity = cmd;
        this.push('system', `feed verbosity: ${cmd}`);
        return;
      case 'diff':
        if (args.length) await this.cli(['diff', ...(this.runId ? [this.runId] : []), ...args]);
        else await this.openDiff();
        return;
      case 'pause':
        if (this.code?.busy) {
          this.code.paused = true;
          this.push('system', 'pausing after the current step; /resume to continue');
        } else if (this.runId) await this.cli(['pause', this.runId]);
        else this.push('system', 'nothing is running');
        return;
      case 'resume':
        if (this.code?.busy) {
          this.code.paused = false;
          this.push('system', 'resumed');
        } else await this.cli(['resume', ...(this.runId ? [this.runId] : []), ...args]);
        return;
      case 'stop':
      case 'abort':
        if (this.interrupt()) return;
        if (this.runId) await this.cli(['stop', this.runId, ...args]);
        else this.push('system', 'nothing is running');
        return;
      case 'status':
      case 'report':
        await this.cli([cmd, ...(this.runId ? [this.runId] : []), ...args]);
        return;
      case 'connect': {
        if (args[0] === 'env') {
          const added = await connectFromEnv(this.io);
          this.push(
            'system',
            added.length
              ? `connected from your environment: ${added.map((k) => k.label).join(', ')}. /model to pick one`
              : 'no API keys found in your environment',
          );
          if (added.length) await this.openModelPicker();
          return;
        }
        // /connect <name|url|key> [key] [--name <alias>]
        const at = args.indexOf('--name');
        const alias = at >= 0 ? args[at + 1] : undefined;
        const rest = at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;
        if (!rest[0]) throw new Error('usage: /connect <name|url|key> [key] [--name <alias>]');
        await this.connect(rest[0], rest[1], alias);
        return;
      }
      case 'chat':
        this.setMode('chat');
        return;
      case 'agents':
        await this.openAgents();
        return;
      case 'models':
        await this.openRanking();
        return;
      case 'model':
        if (!rest) await this.openModelPicker();
        else if (/^https?:\/\//i.test(rest) || looksLikeKey(rest)) {
          // /model <url or key>: connect it, then pick one of its models.
          const [target = '', ...more] = rest.split(/\s+/);
          const at = more.indexOf('--name');
          const name = at >= 0 ? more[at + 1] : undefined;
          const key = more.find((_, i) => i !== at && i !== at + 1);
          await this.connect(target, key, name);
          await this.openModelPicker();
        } else await this.switchModel(rest);
        return;
      case 'go':
        if (this.mode !== 'plan')
          throw new Error('/go approves a plan: switch to plan mode with shift+tab first');
        this.mode = 'chat';
        this.push('system', 'plan approved: carrying it out');
        await this.code_(
          'The plan is approved. Carry it out now, keeping the todo list up to date.',
        );
        return;
      case 'undo': {
        if (this.code?.busy) throw new Error('wait for the agent to finish (or esc), then undo');
        const touched = await this.code?.undo();
        if (touched === undefined) this.push('system', 'nothing to undo');
        else
          this.push(
            'system',
            touched.length
              ? `undone: restored ${touched.length} file${touched.length === 1 ? '' : 's'} (${touched.slice(0, 6).join(', ')}${touched.length > 6 ? ', …' : ''}) and dropped that message`
              : 'undone: no files had changed; dropped that message',
          );
        return;
      }
      case 'compact':
        if (!this.code) {
          this.push('system', 'nothing to compact yet');
          return;
        }
        await this.code.compact(this.view);
        return;
      case 'clear':
        this.todos = [];
        this.code?.clear();
        this.push('system', 'chat conversation cleared');
        return;
      case 'setup':
        await this.openChat(rest);
        return;
      case 'init':
        await this.cli(['init', '--yes']);
        return;
      default: {
        const custom = this.custom.find((c) => c.name === cmd);
        if (custom) {
          // A custom command is a saved prompt: it goes to the agent like a typed message.
          await this.code_(expandCommand(custom, rest));
          return;
        }
        if (
          BLOCKED.has(cmd) ||
          (cmd === 'logs' && args.some((a) => a === '-f' || a === '--follow'))
        )
          throw new Error(
            `/${cmd} needs the plain terminal; run \`omnexx ${line}\` outside the TUI`,
          );
        await this.cli([cmd, ...args]);
      }
    }
  }

  /** The open /agents view: every long run on this machine. */
  agentsView: AgentsState | undefined;
  private agentsAt = 0;

  async openAgents(): Promise<void> {
    this.agentsView = { rows: await loadAgents(resolvePaths(this.io.env), this.now()), cursor: 0 };
    this.agentsAt = this.now();
    this.changed();
  }

  /** Called on the TUI's tick: refresh the agents view every 2 s while it is open. */
  async refreshAgents(): Promise<void> {
    const v = this.agentsView;
    if (!v || this.now() - this.agentsAt < 2_000) return;
    this.agentsAt = this.now();
    const selected = v.rows[v.cursor]?.runId;
    const rows = await loadAgents(resolvePaths(this.io.env), this.now());
    if (!this.agentsView) return;
    const at = rows.findIndex((r) => r.runId === selected);
    this.agentsView = {
      rows,
      cursor: at >= 0 ? at : Math.min(v.cursor, Math.max(0, rows.length - 1)),
    };
    this.changed();
  }

  /** Keys while the agents view is open. */
  async agentsKey(k: 'up' | 'down' | 'attach' | 'pause' | 'stop' | 'close'): Promise<void> {
    const v = this.agentsView;
    if (!v) return;
    const row = v.rows[v.cursor];
    if (k === 'close') this.agentsView = undefined;
    else if (k === 'up') v.cursor = Math.max(0, v.cursor - 1);
    else if (k === 'down') v.cursor = Math.min(v.rows.length - 1, v.cursor + 1);
    else if (row && k === 'attach') {
      this.agentsView = undefined;
      await this.attach(row.runId);
    } else if (row && k === 'pause')
      await this.cli([row.phase === 'paused' ? 'resume' : 'pause', row.runId]);
    else if (row && k === 'stop') await this.cli(['stop', row.runId]);
    this.agentsAt = 0;
    this.changed();
  }

  /** The open /diff viewer, if any; it takes over the keys until closed. */
  diffView: DiffViewState | undefined;

  /** /diff: the attached run's commits since it started, or uncommitted changes in this checkout. */
  async openDiff(): Promise<void> {
    let text: string;
    let title: string;
    if (this.runId) {
      const st = await new RunStore(resolvePaths(this.io.env), this.runId).readState();
      text = (await git(st.worktree, ['diff', `${st.startRef}..${st.lastGreen}`])).stdout;
      title = `${this.runId} since start`;
    } else {
      text = (await git(this.io.cwd, ['diff', 'HEAD'], { allowFailure: true })).stdout;
      title = 'uncommitted changes';
    }
    this.diffView = { title, files: parseDiff(text), cursor: 0, open: new Set() };
    this.changed();
  }

  /** Keys while the diff viewer is open. */
  diffKey(key: 'up' | 'down' | 'enter' | 'close'): void {
    const v = this.diffView;
    if (!v) return;
    if (key === 'close') this.diffView = undefined;
    else if (key === 'up') v.cursor = Math.max(0, v.cursor - 1);
    else if (key === 'down') v.cursor = Math.min(v.files.length - 1, v.cursor + 1);
    else if (v.open.has(v.cursor)) v.open.delete(v.cursor);
    else v.open.add(v.cursor);
    this.changed();
  }

  private files: string[] | undefined;
  private loadingFiles = false;

  /**
   * Repo files matching an `@partial` at the end of the input (tab completes the first).
   * The file list loads once in the background on the first `@`.
   */
  completeFile(input: string): string[] {
    const m = /@([^\s@]*)$/.exec(input);
    if (!m) return [];
    if (!this.files) {
      if (!this.loadingFiles) {
        this.loadingFiles = true;
        void git(this.io.cwd, ['ls-files', '--cached', '--others', '--exclude-standard'], {
          allowFailure: true,
        }).then((r) => {
          this.files = r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : [];
          this.changed();
        });
      }
      return [];
    }
    const q = (m[1] ?? '').toLowerCase();
    const starts = this.files.filter((f) => f.toLowerCase().startsWith(q));
    const contains = this.files.filter(
      (f) => !f.toLowerCase().startsWith(q) && f.toLowerCase().includes(q),
    );
    return [...starts, ...contains].slice(0, 20);
  }

  /** Commands whose name starts with what's typed after `/`. */
  complete(input: string): SlashCommand[] {
    if (!input.startsWith('/') || input.includes(' ')) return [];
    const q = input.slice(1);
    const builtIn = new Set(SLASH.map((c) => c.name));
    return [
      ...SLASH,
      ...this.custom
        .filter((c) => !builtIn.has(c.name))
        .map((c) => ({ name: c.name, help: c.description })),
    ].filter((c) => c.name.startsWith(q));
  }

  /** Slash commands from .omnexx/commands, .claude/commands and the config folder. */
  custom: CustomCommand[] = [];

  async loadCommands(): Promise<void> {
    const root =
      (
        await git(this.io.cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true })
      ).stdout.trim() || this.io.cwd;
    this.custom = await loadCustomCommands(commandDirs(root, resolvePaths(this.io.env).configHome));
    this.changed();
  }
}

export function helpText(b: Brand): string {
  const w = Math.max(...SLASH.map((c) => `/${c.name} ${c.args ?? ''}`.length));
  return [
    b.green('commands'),
    ...SLASH.map((c) => `  ${b.cyan(`/${c.name} ${c.args ?? ''}`.padEnd(w))}  ${c.help}`),
    `  ${b.dim(`also: ${MORE_SLASH.map((c) => `/${c}`).join(' ')}, and any omnexx command`)}`,
    '',
    b.green('typing'),
    '  paste an API key: it is saved and the provider set up (never echoed)',
    '  chat mode (default): the agent works on your message right here, showing every step',
    '    type while it works to steer it (it reads your message at its next step); esc stops it',
    '  run mode (shift+tab, or /run <goal>): a long unattended run on its own branch',
    '  in /setup: your text goes to that model, which can add providers for you',
  ].join('\n');
}
