import { Writable } from 'node:stream';
import { parse } from 'shell-quote';
import { brand, type Brand } from '../cli/brand.js';
import type { CliIO } from '../cli/io.js';
import { pickRun, supervisorAlive } from '../cli/commands/control.js';
import { steerRun } from '../cli/commands/steer.js';
import { git } from '../git/git.js';
import { connect, describeConnect, looksLikeKey } from '../cli/connect.js';
import { maskKey } from '../auth/keys.js';
import { Chat, defaultChatRef, hasProvider } from './chat.js';
import { CodeChat } from './code-chat.js';
import { classifyMarkdown, type MdKind } from './markdown.js';
import { compactPlanView, planCounts } from '../core/plan.js';
import { resolvePaths } from '../core/paths.js';
import { listRunIds, RunStore } from '../core/run-store.js';
import { describeError } from '../errors.js';
import { emptyTelemetry, fold, type Telemetry } from '../telemetry/aggregate.js';
import { EventTail } from '../telemetry/feed.js';
import { humanize, type Verbosity } from '../telemetry/humanize.js';

export type EntryKind = 'feed' | 'out' | 'err' | 'user' | 'system';
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
    name: 'run',
    args: '[goal]',
    help: 'start a long run on <goal>, or switch to run mode (shift+tab)',
  },
  { name: 'plan', args: '[goal]', help: 'show the attached plan, or plan a goal without coding' },
  { name: 'steer', args: '<note>', help: 'redirect the attached run from its next cycle' },
  { name: 'attach', args: '[runId]', help: 'follow a run (default: the latest)' },
  { name: 'detach', help: 'stop following; the run keeps going' },
  { name: 'pause', help: 'pause the attached run at the next turn' },
  { name: 'resume', help: 'resume the attached run' },
  { name: 'stop', args: '[--now]', help: 'stop the attached run' },
  { name: 'status', help: 'phase, progress, spend' },
  { name: 'diff', help: 'what the run has committed so far' },
  { name: 'report', help: 'the morning-after report' },
  { name: 'runs', help: 'list runs' },
  { name: 'connect', args: '<name|url|key> [key]', help: 'add a provider or endpoint in one step' },
  { name: 'chat', help: 'switch to chat: code turn by turn in this checkout (shift+tab)' },
  { name: 'clear', help: 'chat: forget the conversation so far' },
  {
    name: 'setup',
    args: '[provider:model|off]',
    help: 'talk to a model about providers; it can add them for you',
  },
  { name: 'init', help: 'detect gates and write omnexx.toml' },
  { name: 'doctor', help: 'check keys, providers and tools' },
  { name: 'quiet', help: 'feed: commits and verdicts only' },
  { name: 'normal', help: 'feed: every action (default)' },
  { name: 'verbose', help: 'feed: plus every model turn' },
  { name: 'help', help: 'this list' },
  { name: 'quit', help: 'leave omnexx (runs keep going)' },
];

/** Commands that never return or need the real terminal. */
const BLOCKED = new Set(['supervise', 'service']);
const MAX_ENTRIES = 5_000;

/**
 * Everything the TUI does, without React: a transcript of entries, the attached run's live
 * telemetry and plan, and slash commands that reuse the real CLI with its output captured.
 */
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
  mode: 'run' | 'chat' = 'run';
  /** A y/n question from chat mode waiting on the person (permission to go past a guard). */
  pending: { question: string; resolve: (yes: boolean) => void } | undefined;
  private code: CodeChat | undefined;
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
  async greet(): Promise<void> {
    if (await hasProvider(this.io).catch(() => true)) return;
    this.push(
      'system',
      [
        'no model provider yet. any of these works:',
        '  paste an API key (Anthropic, OpenAI, OpenRouter, Groq, xAI, Gemini…)',
        '  /connect ollama              a local model, no key',
        '  /connect https://host/v1 KEY any OpenAI-compatible endpoint',
        'then /setup to talk to it and let it set up the rest',
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
    // A pasted key is never echoed, kept in history, or sent anywhere but the credentials file.
    const key = looksLikeKey(text);
    if (!key) this.history.push(text);
    this.push('user', key ? maskKey(text) : this.chat ? this.chat.redact(text) : text);
    try {
      if (text.startsWith('/')) await this.slash(text.slice(1));
      else if (key && !this.chat) await this.connect(text);
      else if (this.chat) await this.talk(text);
      else if (this.mode === 'chat') await this.code_(text);
      else if (this.runId && this.runAlive) await this.steer(text);
      else await this.startRun(text);
    } catch (err) {
      this.push('err', describeError(err));
    }
  }

  private async connect(target: string, key?: string): Promise<void> {
    this.busy = 'connecting';
    this.changed();
    try {
      this.push('system', describeConnect(await connect(this.io, target, key)));
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

  setMode(mode: 'run' | 'chat'): void {
    this.mode = mode;
    this.push(
      'system',
      mode === 'chat'
        ? 'chat mode: each message is worked on right here in your checkout; checks run after edits'
        : 'run mode: your text starts a long run, or steers the live one',
    );
  }

  private async code_(text: string): Promise<void> {
    this.busy = 'working';
    this.changed();
    try {
      this.code ??= await CodeChat.open(this.io, (q) => this.ask(q));
      await this.code.send(text, (kind, line) => {
        this.push(kind, line, { markdown: kind === 'out' });
      });
      this.push('system', `chat spend $${this.code.usd.toFixed(2)}`);
    } finally {
      this.busy = undefined;
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
      case 'pause':
      case 'resume':
      case 'stop':
      case 'status':
      case 'diff':
      case 'report':
        await this.cli([cmd, ...(this.runId ? [this.runId] : []), ...args]);
        return;
      case 'connect':
        if (!args[0]) throw new Error('usage: /connect <name|url|key> [key]');
        await this.connect(args[0], args[1]);
        return;
      case 'chat':
        this.setMode('chat');
        return;
      case 'clear':
        this.code?.clear();
        this.push('system', 'chat conversation cleared');
        return;
      case 'setup':
        await this.openChat(rest);
        return;
      case 'init':
        await this.cli(['init', '--yes']);
        return;
      default:
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
    return SLASH.filter((c) => c.name.startsWith(q));
  }
}

export function helpText(b: Brand): string {
  const w = Math.max(...SLASH.map((c) => `/${c.name} ${c.args ?? ''}`.length));
  return [
    b.green('commands'),
    ...SLASH.map((c) => `  ${b.cyan(`/${c.name} ${c.args ?? ''}`.padEnd(w))}  ${c.help}`),
    `  ${b.dim('any other /<command> runs `omnexx <command>`, e.g. /providers list')}`,
    '',
    b.green('typing'),
    '  paste an API key: it is saved and the provider set up (never echoed)',
    '  shift+tab switches mode:',
    '    run:  with no live run your text becomes the goal of a new run; while one is live it steers it',
    '    chat: the agent works on your message right here in your checkout, like Claude Code',
    '  in /setup: your text goes to that model, which can add providers for you',
  ].join('\n');
}
