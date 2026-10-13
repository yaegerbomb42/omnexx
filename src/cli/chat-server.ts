import { join } from 'node:path';
import { resolvePaths } from '../core/paths.js';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { describeError } from '../errors.js';
import type { Telemetry } from '../telemetry/aggregate.js';
import type { TodoItem } from '../tools/todo.js';
import type { Entry, Helper, Mode, RunCli } from '../tui/session.js';
import { println, type CliIO } from './io.js';

/**
 * `omnexx chat-server`: the interactive session behind a JSON-lines protocol on stdin/stdout, for
 * editor panels (the VS Code chat). It drives the same Session as the terminal UI, so slash
 * commands, approvals, model switching and plan mode behave the same way.
 *
 * In (one JSON object per line): send {text} · answer {yes} · stop · pause · resume · mode {mode} ·
 * yolo {on} ·
 * model {ref} · models · connect {value, name?} · undo · clear · compact · sync (resend all) ·
 * settings · addProvider {provider?, key?, url?} · removeProvider {name} · testProvider {name} ·
 * roles · setRoles {roles} · contextFiles · setSectionMode {id, mode}.
 * Out: ready {version} · state (below; `entries` holds only lines not sent before) · models
 * {items, unreachable, current} · settings {catalog, connected} · providerTest {name, ok, models,
 * detail} · error {message}.
 */

export interface ChatUsage {
  /** When the chat's first event happened (epoch ms), for an uptime clock. */
  startedAt: number | null;
  tokens: Telemetry['tokens'];
  usd: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  compactions: number;
}

export interface ChatState {
  type: 'state';
  entries: Entry[];
  /** The reply as it streams in; empty once it lands in `entries`. */
  live: string;
  todos: TodoItem[];
  /** A question waiting for allow / deny, or null. */
  pending: string | null;
  mode: Mode;
  busy: boolean;
  paused: boolean;
  autoApprove: boolean;
  model: string | null;
  context: { used: number; limit: number } | null;
  usage: ChatUsage | null;
  run: { id: string; alive: boolean; phase?: string; done?: number; tasks?: number } | null;
  /** Helpers (subagents) for the current message. */
  helpers: Helper[];
  /** The latest browser frame's number and page; the image comes as a `browserFrame` message. */
  browser: { seq: number; url: string; action: string; at: number } | null;
}

/** Frames larger than this are skipped rather than pushed through the pipe. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const MODES = new Set<Mode>(['chat', 'plan', 'run']);
/** Coalesce bursts of changes (a streaming reply fires one per token) into one state line. */
const EMIT_EVERY_MS = 40;

type Command = { type: string } & Record<string, unknown>;

function parseCommand(line: string): Command {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    throw new Error('expected one JSON object per line');
  }
  if (typeof data !== 'object' || data === null || typeof (data as Command).type !== 'string')
    throw new Error('expected an object with a "type"');
  return data as Command;
}

function text(c: Command, key: string): string {
  const v = c[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${c.type}" needs a "${key}" string`);
  return v;
}

export async function serveChat(
  io: CliIO,
  runCli: RunCli,
  opts: { version: string },
): Promise<number> {
  const { Session } = await import('../tui/session.js');
  const session = new Session(io, runCli);
  const write = (msg: object): void => {
    println(io.stdout, JSON.stringify(msg));
  };
  const fail = (err: unknown): void => {
    write({ type: 'error', message: describeError(err) });
  };

  let sentUpTo = -1;
  let sentFrame = 0;
  /** Send the browser's latest screenshot once per new frame. */
  const sendFrame = async (): Promise<void> => {
    const f = session.browserFrame;
    if (!f || f.seq === sentFrame) return;
    sentFrame = f.seq;
    const data = await readFile(f.path).catch(() => undefined);
    if (!data || data.length > MAX_FRAME_BYTES) return;
    write({
      type: 'browserFrame',
      seq: f.seq,
      mime: f.mime,
      url: f.url,
      action: f.action,
      data: data.toString('base64'),
    });
  };
  /** The last entry before the latest new chat; a reloaded panel starts after it. */
  let clearedAt = -1;
  let timer: NodeJS.Timeout | undefined;
  const emit = (): void => {
    timer = undefined;
    const fresh = session.entries.filter((e) => e.id > sentUpTo);
    sentUpTo = session.entries.at(-1)?.id ?? sentUpTo;
    const t = session.chatTelemetry;
    const state: ChatState = {
      type: 'state',
      entries: fresh,
      live: session.live,
      todos: session.todos,
      pending: session.pending?.question ?? null,
      mode: session.mode,
      busy: session.busy !== undefined || session.chatBusy,
      paused: session.chatPaused,
      autoApprove: session.autoApprove,
      model: session.chatModelName ?? null,
      context: session.context ?? null,
      usage: t
        ? {
            startedAt: t.startedAt ?? null,
            tokens: t.tokens,
            usd: t.usd,
            turns: t.turns,
            toolCalls: t.toolCalls,
            toolErrors: t.toolErrors,
            compactions: t.compactions,
          }
        : null,
      run: session.runId ? { id: session.runId, alive: session.runAlive, ...session.info } : null,
      helpers: session.helpers,
      browser: session.browserFrame
        ? {
            seq: session.browserFrame.seq,
            url: session.browserFrame.url,
            action: session.browserFrame.action,
            at: session.browserFrame.at,
          }
        : null,
    };
    write(state);
    void sendFrame();
  };
  const schedule = (): void => {
    timer ??= setTimeout(emit, EMIT_EVERY_MS);
  };
  session.onChange(schedule);

  const sendModels = async (): Promise<void> => {
    const { loadModelChoices } = await import('../tui/model-picker.js');
    const { items, unreachable } = await loadModelChoices(io);
    write({
      type: 'models',
      items: items.filter((i) => i.kind === 'model'),
      unreachable,
      current: session.chatModelName ?? null,
    });
  };
  const sendSettings = async (): Promise<void> => {
    const { providerSettings } = await import('./chat-settings.js');
    write({ type: 'settings', ...(await providerSettings(io)) });
  };
  const sendContextFiles = async (): Promise<void> => {
    const { contextFiles } = await import('./chat-context.js');
    write({ type: 'contextFiles', ...(await contextFiles(io)) });
  };
  /** Roles as saved, plus which models are out of quota right now (ref → when it ran out). */
  const sendRoles = async (): Promise<void> => {
    const { readRoles } = await import('../config/roles.js');
    const { QuotaLedger } = await import('../providers/quota-ledger.js');
    const paths = resolvePaths(io.env);
    write({
      type: 'roles',
      roles: await readRoles(paths),
      exhausted: new QuotaLedger(join(paths.configHome, 'quota.json')).all(),
    });
  };
  /** After a provider change: say what happened, then refresh the settings page and models. */
  const providersChanged = async (message: string): Promise<void> => {
    session.push('system', message);
    await sendSettings();
    await sendModels();
  };

  /** Commands still running, so a closed pipe lets them finish before the process exits. */
  const inflight = new Set<Promise<unknown>>();
  const run = (p: Promise<unknown>): void => {
    const tracked = p.catch(fail).finally(() => {
      inflight.delete(tracked);
      schedule();
    });
    inflight.add(tracked);
  };

  const handle = (c: Command): void => {
    switch (c.type) {
      case 'send':
        run(session.submit(text(c, 'text')));
        return;
      case 'answer':
        if (!session.pending) throw new Error('nothing is waiting for an answer');
        run(session.submit(c.yes === true ? 'y' : 'n'));
        return;
      case 'stop':
      case 'pause':
      case 'resume':
      case 'undo':
      case 'compact':
        run(session.command(c.type));
        return;
      case 'clear':
        run(
          session.command('clear').then(() => {
            // A new chat starts the panel over: nothing from before the clear is sent again.
            clearedAt = session.entries.at(-1)?.id ?? clearedAt;
            sentUpTo = clearedAt;
            write({ type: 'ready', version: opts.version });
            emit();
          }),
        );
        return;
      case 'mode': {
        const mode = c.mode as Mode;
        if (!MODES.has(mode)) throw new Error('mode is one of chat, plan, run');
        if (session.mode !== mode) session.setMode(mode);
        return;
      }
      case 'yolo':
        // /yolo toggles; only run it when the state differs from what was asked, and without
        // echoing it as a message.
        if ((c.on === true) !== session.autoApprove) run(session.command('yolo'));
        return;
      case 'model':
        run(session.switchModel(text(c, 'ref')));
        return;
      case 'models':
        run(sendModels());
        return;
      case 'settings':
        run(sendSettings());
        return;
      case 'addProvider': {
        const str = (k: string): string | undefined => {
          const v = c[k];
          return typeof v === 'string' ? v : undefined;
        };
        run(
          import('./chat-settings.js').then(async ({ addProvider }) => {
            await providersChanged(
              await addProvider(io, {
                provider: str('provider'),
                key: str('key'),
                url: str('url'),
              }),
            );
          }),
        );
        return;
      }
      case 'testProvider':
        run(
          import('./chat-settings.js').then(async ({ testProvider }) => {
            write({ type: 'providerTest', ...(await testProvider(io, text(c, 'name'))) });
          }),
        );
        return;
      case 'contextFiles':
        run(sendContextFiles());
        return;
      case 'setSectionMode':
        run(
          import('./chat-context.js').then(async ({ setSectionMode }) => {
            await setSectionMode(io, text(c, 'id'), text(c, 'mode'));
            await sendContextFiles();
          }),
        );
        return;
      case 'roles':
        run(sendRoles());
        return;
      case 'setRoles':
        run(
          import('../config/roles.js').then(async ({ parseRoles, writeRoles }) => {
            await writeRoles(resolvePaths(io.env), parseRoles(c.roles));
            session.push('system', 'model roles saved; new chats and runs use them');
            await sendRoles();
          }),
        );
        return;
      case 'removeProvider':
        run(
          import('./chat-settings.js').then(async ({ removeProvider }) => {
            await providersChanged(await removeProvider(io, text(c, 'name')));
          }),
        );
        return;
      case 'connect': {
        const name = typeof c.name === 'string' && c.name.trim() ? ` --name ${c.name.trim()}` : '';
        run(session.submit(`/model ${text(c, 'value')}${name}`));
        return;
      }
      case 'sync':
        // A reloaded panel: start it over with the conversation since the last new chat.
        sentUpTo = clearedAt;
        sentFrame = 0;
        write({ type: 'ready', version: opts.version });
        emit();
        return;
      default:
        throw new Error(`unknown command "${c.type}"`);
    }
  };

  await session.loadCommands();
  await session.continueChat().catch(fail);
  await session.greet(false).catch(fail);
  write({ type: 'ready', version: opts.version });
  emit();

  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(parseCommand(line));
    } catch (err) {
      fail(err);
    }
  }
  // The editor closed the pipe: end any turn in progress, let running commands finish, then
  // flush the last state.
  if (session.chatBusy) await session.command('stop');
  await Promise.allSettled([...inflight]);
  if (timer) {
    clearTimeout(timer);
    emit();
  }
  return 0;
}
