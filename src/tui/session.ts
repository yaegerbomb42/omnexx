import { Writable } from 'node:stream';
import { parse } from 'shell-quote';
import { brand, type Brand } from '../cli/brand.js';
import type { CliIO } from '../cli/io.js';
import { pickRun, supervisorAlive } from '../cli/commands/control.js';
import { steerRun } from '../cli/commands/steer.js';
import { connect, describeConnect, looksLikeKey } from '../cli/connect.js';
import { maskKey } from '../auth/keys.js';
import { Chat, defaultChatRef, hasProvider } from './chat.js';
import { compactPlanView } from '../core/plan.js';
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
}

export type RunCli = (argv: readonly string[], io: CliIO) => Promise<number>;

export interface SlashCommand {
  name: string;
  args?: string;
  help: string;
}

/** Built-in slash commands; anything else after `/` runs the CLI command of that name. */
export const SLASH: readonly SlashCommand[] = [
  { name: 'run', args: '<goal>', help: 'start a long run in the background and attach to it' },
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
  {
    name: 'chat',
    args: '[provider:model|off]',
    help: 'talk to a model directly; it can add providers',
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
  busy: string | undefined;
  verbosity: Verbosity = 'normal';
  quit = false;
  chat: Chat | undefined;
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

  push(kind: EntryKind, text: string): void {
    for (const line of text.replace(/\n$/, '').split('\n')) {
      this.entries.push({ id: this.nextId++, kind, text: line });
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
        'then /chat to talk to it and let it set up the rest',
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
    if (!text) return;
    // A pasted key is never echoed, kept in history, or sent anywhere but the credentials file.
    const key = looksLikeKey(text);
    if (!key) this.history.push(text);
    this.push('user', key ? maskKey(text) : this.chat ? this.chat.redact(text) : text);
    try {
      if (text.startsWith('/')) await this.slash(text.slice(1));
      else if (key && !this.chat) await this.connect(text);
      else if (this.chat) await this.talk(text);
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
        this.push('out', line);
      });
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  private async openChat(arg: string): Promise<void> {
    if (arg === 'off') {
      this.chat = undefined;
      this.push('system', 'chat off: plain text starts a run again');
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
      `chatting with ${ref}. ask it to add providers, e.g. "connect my groq key". /chat off to leave`,
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
        if (!rest) throw new Error('usage: /run <goal>');
        await this.startRun(rest);
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
    '  in /chat: your text goes to that model, which can add providers for you',
    '  with no live run: your text becomes the goal of a new run',
    '  while a run is live: your text steers it from the next cycle',
  ].join('\n');
}
