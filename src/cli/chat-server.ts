import { join } from 'node:path';
import { resolvePaths } from '../core/paths.js';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { describeError } from '../errors.js';
import type { Telemetry } from '../telemetry/aggregate.js';
import type { TodoItem } from '../tools/todo.js';
import type { Entry, Helper, Mode, RunCli } from '../tui/session.js';
import { providerExtras } from './provider-messages.js';
import { println, type CliIO } from './io.js';

/**
 * `omnexx chat-server`: the interactive session behind a JSON-lines protocol on stdin/stdout, for
 * editor panels (the VS Code chat). It drives the same Session as the terminal UI, so slash
 * commands, approvals, model switching and plan mode behave the same way.
 *
 * In (one JSON object per line): send {text} · answer {yes} · stop · pause · resume · mode {mode} ·
 * yolo {on} · trace {on} ·
 * model {ref} · models · connect {value, name?} · undo · clear · compact · sync (resend all) ·
 * settings · addProvider {provider?, key?, url?, fields?, headers?, flavor?} ·
 * probeProvider {provider?, url?, key?, fields?, headers?, flavor?} · removeProvider {name} · testProvider {name} ·
 * roles · setRoles {roles?, pool?: {ranked, mode}} · contextFiles · setSectionMode {id, mode} · contextList ·
 * contextUpdate {id, text} · contextDelete {id} · contextReset · contextAdd {text} · contextPin {id} ·
 * contextRestore {id} · skills · skillsSearch {query} · skillsPreview {id} · skillsInstall {id} ·
 * skillsUpdate · skillsRemove {name, mode?: hide|delete, path?} · skillsUnhide {name} · skillsToggle {name, on} · skillsMarketAdd {source} · chats ·
 * resumeChat {id} · browser · setBrowser {engine, profile?, sessionName?, headless} · mcp {op, …}
 * (see chat-mcp.ts) · agentSettings · setAgentSettings {levels, askOnStart}.
 * Out: ready {version} · state (below; `entries` holds only lines not sent before) · models
 * {items, unreachable, current} · settings {catalog, connected} · providerTest {name, ok, models,
 * detail} · contextItems {items, busy, budget} · skills… (see chat-skills.ts) · chats {chats} · browser {engine, profile, sessionName, headless} ·
 * agentSettings {levels, askOnStart, saved, summary, meta} · error {message}.
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
  /** Button names when the question is an offer (Pull it now / Not now) rather than a guard. */
  pendingLabels: { yes: string; no: string } | null;
  mode: Mode;
  busy: boolean;
  paused: boolean;
  autoApprove: boolean;
  /** Per-turn trace lines (`/trace`). Off by default. */
  trace: boolean;
  model: string | null;
  /** How the chat's ranked models are used ("Fallback on quota"), when it has several. */
  routing: string | null;
  /** Tokens in use, the compaction limit, and what they are made of. */
  context: {
    used: number;
    limit: number;
    parts?: { system: number; tools: number; conversation: number };
  } | null;
  /** The rolling memory note (what the agent remembers), or null before the first condensation. */
  memoryNote: string | null;
  usage: ChatUsage | null;
  run: { id: string; alive: boolean; phase?: string; done?: number; tasks?: number } | null;
  /** Helpers (subagents) for the current message. */
  helpers: Helper[];
  /** A model request in flight: when it went out and how long it usually takes (null: unknown). */
  waiting: { startedAt: number; estimateMs: number | null } | null;
  /** "est. ~3 min, ~40k tokens, ~$0.02" before work, "~2 min left" during it, or null. */
  estimate: string | null;
  /** The latest browser frame's number and page; the image comes as a `browserFrame` message. */
  browser: { seq: number; url: string; action: string; at: number } | null;
  /** Latest frontend diagnostics counts; the full lists come as a `browserDiagnostics` message. */
  browserDiagnostics: {
    seq: number;
    at: number;
    summary: string;
    errors: number;
    warnings: number;
    failedRequests: number;
  } | null;
  /** Latest visual comparison; the diff image comes as a `browserVisual` message. */
  browserVisual: {
    seq: number;
    at: number;
    name: string;
    pass: boolean;
    changedRatio: number;
    dimensionsMatch: boolean;
  } | null;
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

/** A string that may be empty (an edit can clear a block's text). */
function rawText(c: Command, key: string): string {
  const v = c[key];
  if (typeof v !== 'string') throw new Error(`"${c.type}" needs a "${key}" string`);
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
    if (!io.stdout.writable) return;
    try {
      println(io.stdout, JSON.stringify(msg));
    } catch {
      // Client closed the pipe (EPIPE / destroyed stream).
    }
  };
  const fail = (err: unknown): void => {
    write({ type: 'error', message: describeError(err) });
  };
  io.stdout.on('error', () => {
    // Writes after the editor disconnects surface as EPIPE; don't crash the process.
  });

  let sentUpTo = -1;
  let sentFrame = 0;
  let sentDiagnostics = 0;
  let sentVisual = 0;
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
  /** Send the full console/network report once per new diagnostics event. */
  const sendDiagnostics = (): void => {
    const d = session.browserDiagnostics;
    if (!d || d.seq === sentDiagnostics) return;
    sentDiagnostics = d.seq;
    write({ type: 'browserDiagnostics', ...d });
  };
  /** Send the visual comparison (diff image when there is one) once per result. */
  const sendVisual = async (): Promise<void> => {
    const v = session.browserVisual;
    if (!v || v.seq === sentVisual) return;
    sentVisual = v.seq;
    const file = v.diff ?? v.current;
    const data = await readFile(file).catch(() => undefined);
    write({
      type: 'browserVisual',
      ...v,
      ...(data && data.length <= MAX_FRAME_BYTES
        ? { mime: 'image/png', data: data.toString('base64') }
        : {}),
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
      pendingLabels: session.pending?.labels ?? null,
      mode: session.mode,
      busy: session.busy !== undefined || session.chatBusy,
      paused: session.chatPaused,
      autoApprove: session.autoApprove,
      trace: session.trace,
      model: session.chatModelName ?? null,
      routing: session.chatRouting ?? null,
      context: session.context ?? null,
      memoryNote: session.chatMemoryNote ?? null,
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
      waiting: session.waiting,
      estimate: session.estimate,
      browser: session.browserFrame
        ? {
            seq: session.browserFrame.seq,
            url: session.browserFrame.url,
            action: session.browserFrame.action,
            at: session.browserFrame.at,
          }
        : null,
      browserDiagnostics: session.browserDiagnostics
        ? {
            seq: session.browserDiagnostics.seq,
            at: session.browserDiagnostics.at,
            summary: session.browserDiagnostics.summary,
            errors: session.browserDiagnostics.errors,
            warnings: session.browserDiagnostics.warnings,
            failedRequests: session.browserDiagnostics.failedRequests,
          }
        : null,
      browserVisual: session.browserVisual
        ? {
            seq: session.browserVisual.seq,
            at: session.browserVisual.at,
            name: session.browserVisual.name,
            pass: session.browserVisual.pass,
            changedRatio: session.browserVisual.changedRatio,
            dimensionsMatch: session.browserVisual.dimensionsMatch,
          }
        : null,
    };
    write(state);
    void sendFrame().catch(() => undefined);
    sendDiagnostics();
    void sendVisual().catch(() => undefined);
  };
  const schedule = (): void => {
    timer ??= setTimeout(emit, EMIT_EVERY_MS);
  };
  const offChange = session.onChange(schedule);

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
  const sendBrowser = async (): Promise<void> => {
    const { browserSettings } = await import('./chat-settings.js');
    write({ type: 'browser', ...(await browserSettings(io)) });
  };
  const sendContextFiles = async (): Promise<void> => {
    const { contextFiles } = await import('./chat-context.js');
    write({ type: 'contextFiles', ...(await contextFiles(io)) });
  };
  /** The context inspector's items: what the next request sends, with token counts. */
  const sendContext = (): void => {
    write({
      type: 'contextItems',
      items: session.contextItems(),
      busy: session.chatBusy,
      budget: session.contextBudget,
    });
  };
  /**
   * The ranked list everyone uses (the /models pool) and its mode, per-role lists, and which
   * models are out of quota right now (ref → when it ran out).
   */
  const sendRoles = async (): Promise<void> => {
    const { readRoles } = await import('../config/roles.js');
    const { readPoolMode, readRanking } = await import('../config/ranking.js');
    const { QuotaLedger } = await import('../providers/quota-ledger.js');
    const paths = resolvePaths(io.env);
    write({
      type: 'roles',
      roles: await readRoles(paths),
      pool: { ranked: await readRanking(paths), mode: await readPoolMode(paths) },
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
      case 'trace':
        if ((c.on === true) !== session.trace) run(session.command('trace'));
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
                ...providerExtras(c),
              }),
            );
          }),
        );
        return;
      }
      case 'probeProvider':
        run(
          import('./provider-setup.js').then(async ({ probeProvider }) => {
            const str = (k: string): string | undefined => {
              const v = c[k];
              return typeof v === 'string' ? v : undefined;
            };
            const r = await probeProvider(io, {
              provider: str('provider'),
              url: str('url'),
              key: str('key'),
              ...providerExtras(c),
            });
            write({ type: 'providerProbe', ...r, models: r.models.slice(0, 50) });
          }),
        );
        return;
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
      case 'chats':
        run(
          session.savedChats().then((chats) => {
            write({ type: 'chats', chats });
          }),
        );
        return;
      case 'resumeChat':
        run(
          (async () => {
            // Mark the panel's start first, so a reload shows only the reopened chat.
            clearedAt = session.entries.at(-1)?.id ?? clearedAt;
            sentUpTo = clearedAt;
            await session.resumeChat(text(c, 'id'));
            write({ type: 'ready', version: opts.version });
            emit();
          })(),
        );
        return;
      case 'contextList':
        sendContext();
        return;
      case 'contextUpdate':
        session.changeContext({ op: 'edit', id: text(c, 'id'), text: rawText(c, 'text') });
        sendContext();
        return;
      case 'contextDelete':
        session.changeContext({ op: 'delete', id: text(c, 'id') });
        sendContext();
        return;
      case 'contextReset':
        session.changeContext({ op: 'reset' });
        sendContext();
        return;
      case 'contextClearChat':
        session.changeContext({ op: 'clearChat' });
        sendContext();
        return;
      case 'contextAdd':
        session.changeContext({ op: 'add', text: text(c, 'text') });
        sendContext();
        return;
      case 'contextPin':
      case 'contextRestore':
        session.changeContext({
          op: c.type === 'contextPin' ? 'pin' : 'restore',
          id: text(c, 'id'),
        });
        sendContext();
        return;
      case 'skills':
      case 'skillsSearch':
      case 'skillsPreview':
      case 'skillsInstall':
      case 'skillsUpdate':
      case 'skillsRemove':
      case 'skillsUnhide':
      case 'skillsToggle':
      case 'skillsMarketAdd':
        run(
          import('./chat-skills.js').then(async ({ handleSkills }) => {
            write(await handleSkills(io, c));
          }),
        );
        return;
      case 'browser':
        run(sendBrowser());
        return;
      case 'setBrowser':
        run(
          import('./chat-settings.js').then(async ({ setBrowserSettings }) => {
            await setBrowserSettings(io, c);
            await sendBrowser();
          }),
        );
        return;
      case 'roles':
        run(sendRoles());
        return;
      case 'mcp':
        run(
          import('./chat-mcp.js').then(({ handleMcp }) =>
            handleMcp(
              {
                io,
                write,
                note: (t) => {
                  session.push('system', t);
                },
              },
              c,
            ),
          ),
        );
        return;
      case 'setRoles':
        run(
          import('../config/roles.js').then(async ({ parseRoles, writeRoles, ROLES_VERSION }) => {
            const paths = resolvePaths(io.env);
            if (typeof c.roles === 'object' && c.roles)
              await writeRoles(paths, parseRoles({ ...c.roles, version: ROLES_VERSION }));
            const pool = c.pool as { ranked?: unknown; mode?: unknown } | undefined;
            if (pool) {
              const { parsePoolMode, writePool } = await import('../config/ranking.js');
              const ranked = Array.isArray(pool.ranked)
                ? pool.ranked.filter((r): r is string => typeof r === 'string')
                : [];
              await writePool(paths, ranked, parsePoolMode(pool.mode));
            }
            await sendRoles();
          }),
        );
        return;
      case 'autoCalibrate':
        run(
          (async () => {
            const paths = resolvePaths(io.env);
            const { autoCalibrateModels } = await import('../config/auto-calibrate.js');
            const { loadModelChoices } = await import('../tui/model-picker.js');
            const { items } = await loadModelChoices(io);
            const refs = items.filter((m) => m.kind === 'model').map((m) => m.ref);
            const res = await autoCalibrateModels(paths, refs);
            await sendRoles();
            write({ type: 'notify', level: 'info', message: res.summary });
          })(),
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
      case 'agentSettings':
      case 'setAgentSettings':
        run(
          import('./chat-agent-settings.js').then(({ agentSettingsCommand }) =>
            agentSettingsCommand(c, session, write),
          ),
        );
        return;
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
  try {
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
    if (session.chatBusy) await session.command('stop').catch(fail);
    await Promise.allSettled([...inflight]);
    if (timer) {
      clearTimeout(timer);
      if (io.stdout.writable) emit();
    }
  } finally {
    offChange();
    if (timer) clearTimeout(timer);
    lines.close();
  }
  return 0;
}
