import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { OmnexxConfig } from '../../config/schema.js';
import { checkCommand } from '../../security/command-policy.js';
import { checkBrowserToolPolicy } from '../../security/policy-extra.js';
import {
  collectBrowserDiagnostics,
  diagnosticsNote,
  formatBrowserDiagnostics,
  hasDiagnostics,
  isFailedRequest,
  type BrowserDiagnostics,
} from '../../browser/diagnostics.js';
import { diffPng, formatDiff, summarizeDiff } from '../../browser/visual-diff.js';
import type { ToolSource } from '../extra/types.js';
import { fail, ok, resolvePath, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import { detectBrowserBackend } from './browser/detector.js';
import { BrowserSessionManager, type BrowserManagerOptions } from './browser/manager.js';
import { isUrlAllowed } from './browser/security.js';
import { privateTarget } from './private-address.js';
import { trimSnapshot } from './browser/snapshot.js';
import { asLayoutReport, formatPageCheck, LAYOUT_PROBE } from './browser/page-check.js';
import type { BrowserBackend, BrowserRequest } from './browser/types.js';

const ACTIONS = [
  'open',
  'snapshot',
  'click',
  'type',
  'fill',
  'press',
  'scroll',
  'hover',
  'select',
  'check',
  'uncheck',
  'upload',
  'wait_for',
  'get_text',
  'get_url',
  'eval',
  'network',
  'console',
  'diagnostics',
  'tabs',
  'switch_tab',
  'new_tab',
  'close_tab',
  'back',
  'forward',
  'reload',
  'start_server',
  'stop_server',
  'server_status',
  'screenshot',
  'visual_check',
  'check_page',
  'close',
] as const;

const MIN_WIDTH = 200;
const MAX_WIDTH = 3840;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 2160;
/** Viewport height used when `check` sets a width. */
const CHECK_HEIGHT = 900;
const TIMEOUT = /timeout \d+ ?ms exceeded|timed out after/i;

const browserActionSchema = z.strictObject({
  action: z.enum(ACTIONS).describe('The browser action to perform'),
  url: z
    .string()
    .optional()
    .describe('URL for open/new_tab; for check_page also a repo HTML file path'),
  ref: z
    .string()
    .optional()
    .describe(
      'Element: snapshot ref ("@e1"), CSS selector, text=Save, label=Email, placeholder=Search, or role=button[name="Save"]',
    ),
  text: z
    .string()
    .optional()
    .describe('Text to type (type, fill), or text to wait for (wait_for without ref)'),
  key: z.string().optional().describe('Key to press, e.g. "Enter", "Tab" (for action="press")'),
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('Direction to scroll (for action="scroll")'),
  value: z.string().optional().describe('Option value or visible label to choose (select)'),
  path: z.string().optional().describe('Repo-relative file to upload (upload)'),
  tab: z.string().optional().describe('Tab id from action="tabs" (switch_tab, close_tab)'),
  expression: z
    .string()
    .optional()
    .describe('JS expression evaluated in the page; its JSON result is returned (eval)'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .optional()
    .describe('How long wait_for waits (default 10000)'),
  width: z
    .number()
    .int()
    .min(MIN_WIDTH)
    .max(MAX_WIDTH)
    .optional()
    .describe('check_page/visual_check: viewport width in px, e.g. 375 for a phone'),
  height: z
    .number()
    .int()
    .min(MIN_HEIGHT)
    .max(MAX_HEIGHT)
    .optional()
    .describe('visual_check: viewport height in px (default 900)'),
  command: z
    .string()
    .optional()
    .describe('start_server: dev-server command, e.g. "npm run dev" (defaults to browser.serve)'),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe('start_server: port the server listens on (defaults to browser.serve_port)'),
  level: z
    .enum(['all', 'warning', 'error'])
    .optional()
    .describe('console: show all messages (default), warnings and above, or errors only'),
  failed_only: z.boolean().optional().describe('network: only 4xx/5xx and network failures'),
  clear: z.boolean().optional().describe('console/network: clear the buffer before returning'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('console/network/diagnostics: maximum entries to show (default 50)'),
  name: z
    .string()
    .regex(/^[A-Za-z0-9][\w.-]{0,63}$/)
    .optional()
    .describe('visual_check: baseline name, e.g. "checkout-button" or "home-375"'),
  update: z
    .boolean()
    .optional()
    .describe('visual_check: replace the stored baseline with the current screenshot'),
  threshold: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'visual_check: percent of pixels allowed to differ (default browser.visual_diff_threshold)',
    ),
});

export type BrowserActionInput = z.infer<typeof browserActionSchema>;

const DEFAULT_WAIT_MS = 10_000;
/** Settling after open/click is best-effort: a page that never goes idle shouldn't stall the run. */
const SETTLE_MS = 5_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_LIST_ITEMS = 50;
const MAX_LINE_CHARS = 300;
/** Snapshot attached to a "ref not found" error, smaller than a normal one. */
const RETRY_SNAPSHOT_TOKENS = 1_500;

// Global map of runId -> BrowserSessionManager to preserve session across tool calls in a run
const activeSessions = new Map<string, BrowserSessionManager>();

// Register process exit cleanup hook to kill orphan sessions
process.on('exit', () => {
  for (const session of activeSessions.values()) {
    void session.close();
  }
});

export function getOrCreateSession(
  runId: string,
  config: OmnexxConfig['browser'],
  worktreeRoot: string,
  options: Pick<BrowserManagerOptions, 'createBackend' | 'createDevServer'> = {},
): BrowserSessionManager {
  let session = activeSessions.get(runId);
  if (!session) {
    session = new BrowserSessionManager({ runId, config, worktreeRoot, ...options });
    activeSessions.set(runId, session);
  }
  return session;
}

export async function closeSession(runId: string): Promise<void> {
  const session = activeSessions.get(runId);
  if (session) {
    activeSessions.delete(runId);
    await session.close();
  }
}

const clip = (t: string, n = MAX_TEXT_CHARS): string =>
  t.length > n ? `${t.slice(0, n)}… (${t.length - n} more chars)` : t;

/** The last `MAX_LIST_ITEMS` lines, with a note on how many earlier ones were dropped. */
function capList(lines: string[]): string {
  const kept = lines.slice(-MAX_LIST_ITEMS).map((l) => clip(l, MAX_LINE_CHARS));
  const dropped = lines.length - kept.length;
  return (dropped > 0 ? [`… ${dropped} earlier entries omitted`, ...kept] : kept).join('\n');
}

const REF = /^@?e\d+$/;
const STALE =
  /unknown ref|stale|not attached|detached|no (such )?element|not found|resolved to 0 elements|no node/i;

/** A ref the page no longer has, as opposed to a real failure of the action. */
const isStaleRef = (ref: string, err: unknown): boolean =>
  REF.test(ref.trim()) && STALE.test(err instanceof Error ? err.message : String(err));

/** The browser itself is gone or wedged: keep nothing around that would leak a process. */
const FATAL =
  /has been closed|browser closed|failed to launch|no browser backend|daemon may be busy|crash|disconnected/i;

class StaleRefError extends Error {}
/** The model left out a parameter: its message is the whole answer. */
class UsageError extends Error {}

/**
 * Runs an element action; when its snapshot ref is stale, takes a fresh snapshot (which
 * re-indexes refs) and tries once more.
 */
async function withRefRetry(
  backend: BrowserBackend,
  ref: string,
  act: () => Promise<void>,
): Promise<boolean> {
  try {
    await act();
    return false;
  } catch (err) {
    if (!isStaleRef(ref, err)) throw err;
  }
  const snap = await backend.snapshot().catch(() => '');
  try {
    await act();
    return true;
  } catch (err) {
    if (!isStaleRef(ref, err)) throw err;
    const shown = snap ? `\n\nCurrent snapshot:\n${trimSnapshot(snap, RETRY_SNAPSHOT_TOKENS)}` : '';
    throw new StaleRefError(
      `ref ${ref} not found on the page (it may have changed). Pick a ref from the current snapshot below, or take a snapshot first.${shown}`,
    );
  }
}

async function settle(backend: BrowserBackend): Promise<void> {
  await backend.waitForLoad?.(SETTLE_MS).catch(() => undefined);
}

/** Width and height from a PNG's IHDR chunk. */
function pngDims(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): string {
  const { width, height } = pngDims(buf);
  return width ? `${String(width)}x${String(height)}` : 'unknown size';
}

const pngWidth = (buf: Buffer): number => pngDims(buf).width;
const pngHeight = (buf: Buffer): number => pngDims(buf).height;

/** Saves a screenshot under the run's logs, never the repo, so it can't end up in a commit. */
async function saveScreenshot(
  ctx: ToolContext,
  backend: BrowserBackend,
): Promise<{ file: string; info: string }> {
  const shot = await backend.screenshot();
  const dir = join(ctx.store.logsDir, 'browser');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ext = shot.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const file = join(dir, `screenshot-${ctx.cycle}-${Date.now()}.${ext}`);
  const buf = Buffer.from(shot.base64, 'base64');
  await writeFile(file, buf, { mode: 0o600 });
  return {
    file,
    info: `${ext === 'png' ? pngSize(buf) : 'jpeg'}, ${Math.round(buf.length / 1024)} KB`,
  };
}

/** A screenshot of the page, or of one element when `ref` is given. */
async function captureVisual(backend: BrowserBackend, ref: string | undefined): Promise<Buffer> {
  if (!ref) return Buffer.from((await backend.screenshot()).base64, 'base64');
  if (!backend.screenshotElement) {
    throw new Error(
      `the ${backend.name} browser backend cannot screenshot an element; call visual_check without "ref" to compare the whole viewport`,
    );
  }
  return Buffer.from((await backend.screenshotElement(ref)).base64, 'base64');
}

/** Baselines and diff images stay under the run's logs, keyed by a model-chosen name. */
function visualPaths(
  ctx: ToolContext,
  name: string,
): {
  baseline: string;
  current: string;
  diff: string;
} {
  const root = join(ctx.store.logsDir, 'browser');
  return {
    baseline: join(root, 'baselines', `${name}.png`),
    current: join(root, 'visual', `${name}-current.png`),
    diff: join(root, 'visual', `${name}-diff.png`),
  };
}

async function writeUnderLogs(file: string, buf: Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, buf, { mode: 0o600 });
}

/** Parse a stored baseline; a missing one is not an error worth throwing. */
async function readBaseline(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

const visualEvent = (
  name: string,
  summary: ReturnType<typeof summarizeDiff>,
  files: { baseline: string; current: string; diff?: string },
): Record<string, unknown> => ({
  action: 'compare',
  name,
  ...summary,
  baseline: files.baseline,
  current: files.current,
  ...(files.diff ? { diff: files.diff } : {}),
});

function emitDiagnostics(
  ctx: ToolContext,
  d: BrowserDiagnostics,
  url: string,
  action = 'diagnostics',
): void {
  ctx.events.emit('browser.diagnostics', {
    action,
    url,
    errors: d.errors,
    warnings: d.warnings,
    failedRequests: d.failedRequests,
    console: d.console,
    requests: d.requests,
    summary: d.summary,
  });
}

const unsupported = (backend: BrowserBackend, action: string): ToolOutput =>
  fail(
    `action "${action}" is not supported by the ${backend.name} browser backend; use snapshot and the core actions (open, click, type, press) instead`,
  );

export interface BrowserToolOptions {
  /** Tests inject a fake backend; default: detect one. */
  createBackend?: BrowserManagerOptions['createBackend'];
  /** Tests inject a fake dev server; default: spawn the command. */
  createDevServer?: BrowserManagerOptions['createDevServer'];
}

/** Actions after which the page may look different, so the live view takes a new frame. */
const PAGE_CHANGING = new Set([
  'open',
  'click',
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'scroll',
  'wait_for',
  'switch_tab',
  'new_tab',
  'close_tab',
  'upload',
  'hover',
  'back',
  'forward',
  'reload',
]);

/** Actions whose output carries a diagnostics summary when new problems appeared. */
const DIAGNOSTIC_ACTIONS = new Set([
  'open',
  'click',
  'type',
  'fill',
  'press',
  'scroll',
  'hover',
  'select',
  'check',
  'uncheck',
  'upload',
  'wait_for',
  'switch_tab',
  'new_tab',
  'back',
  'forward',
  'reload',
]);

/**
 * The live view: one screenshot after a page-changing action, overwritten each time, under the
 * run's logs. Best effort: a failed capture never fails the action the agent asked for.
 */
async function liveFrame(
  ctx: ToolContext,
  session: BrowserSessionManager,
  action: string,
): Promise<void> {
  try {
    const backend = await session.getBackend();
    const shot = await backend.screenshot();
    const dir = join(ctx.store.logsDir, 'browser');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const ext = shot.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const file = join(dir, `live.${ext}`);
    await writeFile(file, Buffer.from(shot.base64, 'base64'), { mode: 0o600 });
    const url = backend.getUrl ? await backend.getUrl().catch(() => '') : '';
    ctx.events.emit('browser.frame', { path: file, mime: shot.mimeType, url, action });
  } catch {
    // The page may be closing or mid-navigation; the next action takes another frame.
  }
}

/** A timed-out element action, explained, with a small snapshot to pick a better target from. */
async function timeoutHelp(
  session: BrowserSessionManager,
  input: BrowserActionInput,
  msg: string,
): Promise<string> {
  const backend = await session.getBackend().catch(() => null);
  const snap = backend ? await backend.snapshot().catch(() => '') : '';
  const shown = snap ? `\n\nCurrent snapshot:\n${trimSnapshot(snap, RETRY_SNAPSHOT_TOKENS)}` : '';
  return `browser ${input.action} failed: no visible, enabled element matched ${input.ref ?? ''} in time (${msg.split('\n')[0] ?? msg}). Pick a ref from the snapshot below, try text=/role= targets, or wait_for the element first.${shown}`;
}

export function createBrowserTool(
  config: OmnexxConfig['browser'],
  opts: BrowserToolOptions = {},
): Tool<typeof browserActionSchema> {
  async function run(
    input: BrowserActionInput,
    ctx: ToolContext,
    session: BrowserSessionManager,
  ): Promise<ToolOutput> {
    const emit = (data: Record<string, unknown>): void => {
      ctx.events.emit('browser.action', { action: input.action, ...data });
    };
    const needRef = (): string => {
      if (!input.ref) throw new UsageError(`action "${input.action}" requires "ref" parameter`);
      return input.ref;
    };
    const checkUrl = async (url: string | undefined): Promise<string | ToolOutput> => {
      if (!url) return fail(`action "${input.action}" requires "url" parameter`);
      if (!isUrlAllowed(url, config.allow)) {
        ctx.events.emit('browser.denied', {
          url,
          allow: config.allow,
          reason: `URL ${url} is not permitted by browser.allow allowlist`,
        });
        return fail(`URL "${url}" is refused by browser allowlist (${config.allow.join(', ')})`);
      }
      // Named (non-wildcard) hosts opt out of the private-address check, matching web_fetch.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail(`URL "${url}" is not a valid absolute URL`);
      }
      const named = config.allow.filter((a: string) => a !== '*');
      if (!(
        named.length &&
        named.some((a) => parsed.hostname === a || parsed.hostname.endsWith('.' + a))
      )) {
        const why = await privateTarget(parsed.hostname);
        if (why) {
          ctx.events.emit('browser.denied', { url, allow: config.allow, reason: why });
          return fail(`URL "${url}" is refused: ${why}`);
        }
      }
      return url;
    };
    const retried = (r: boolean): string => (r ? ' (after refreshing a stale ref)' : '');

    switch (input.action) {
      case 'open': {
        const url = await checkUrl(input.url);
        if (typeof url !== 'string') return url;
        await session.ensureDevServerForUrl(url);
        const backend = await session.getBackend();
        await session.resetDiagnostics();
        await backend.open(url);
        await settle(backend);
        ctx.events.emit('browser.open', { url, backend: backend.name });
        const snap = await backend.snapshot();
        return ok(`Opened ${url}\n\nSnapshot:\n${trimSnapshot(snap)}`);
      }

      case 'reload':
      case 'back':
      case 'forward': {
        const backend = await session.getBackend();
        const nav =
          input.action === 'reload'
            ? backend.reload?.bind(backend)
            : input.action === 'back'
              ? backend.goBack?.bind(backend)
              : backend.goForward?.bind(backend);
        if (!nav) return unsupported(backend, input.action);
        await nav();
        await settle(backend);
        const url = backend.getUrl ? await backend.getUrl().catch(() => '') : '';
        emit({ url });
        return ok(
          `${input.action === 'reload' ? 'Reloaded' : input.action === 'back' ? 'Went back' : 'Went forward'}${url ? ` to ${url}` : ''}\n\nSnapshot:\n${trimSnapshot(await backend.snapshot())}`,
        );
      }

      case 'snapshot': {
        const backend = await session.getBackend();
        const snap = await backend.snapshot();
        emit({});
        return ok(trimSnapshot(snap));
      }

      case 'click': {
        const ref = needRef();
        const backend = await session.getBackend();
        const r = await withRefRetry(backend, ref, () => backend.click(ref));
        await settle(backend);
        emit({ ref });
        return ok(`Clicked ${ref}${retried(r)}`);
      }

      case 'type':
      case 'fill': {
        const ref = needRef();
        if (input.text === undefined) {
          return fail(`action "${input.action}" requires "ref" and "text" parameters`);
        }
        const text = input.text;
        const backend = await session.getBackend();
        let act: () => Promise<void>;
        if (input.action === 'type') act = () => backend.type(ref, text);
        else if (backend.fill) {
          const fill = backend.fill.bind(backend);
          act = () => fill(ref, text);
        } else return unsupported(backend, 'fill');
        const r = await withRefRetry(backend, ref, act);
        emit({ ref, text });
        return ok(`${input.action === 'fill' ? 'Filled' : 'Typed into'} ${ref}${retried(r)}`);
      }

      case 'hover': {
        const ref = needRef();
        const backend = await session.getBackend();
        if (!backend.hover) return unsupported(backend, 'hover');
        const hover = backend.hover.bind(backend);
        const r = await withRefRetry(backend, ref, () => hover(ref));
        emit({ ref });
        return ok(`Hovering over ${ref}${retried(r)}`);
      }

      case 'select': {
        const ref = needRef();
        if (input.value === undefined) return fail('action "select" requires "ref" and "value"');
        const value = input.value;
        const backend = await session.getBackend();
        if (!backend.select) return unsupported(backend, 'select');
        const select = backend.select.bind(backend);
        const r = await withRefRetry(backend, ref, () => select(ref, value));
        emit({ ref, value });
        return ok(`Selected "${value}" in ${ref}${retried(r)}`);
      }

      case 'check':
      case 'uncheck': {
        const ref = needRef();
        const checked = input.action === 'check';
        const backend = await session.getBackend();
        if (!backend.setChecked) return unsupported(backend, input.action);
        const setChecked = backend.setChecked.bind(backend);
        const r = await withRefRetry(backend, ref, () => setChecked(ref, checked));
        emit({ ref });
        return ok(`${checked ? 'Checked' : 'Unchecked'} ${ref}${retried(r)}`);
      }

      case 'upload': {
        const ref = needRef();
        if (!input.path) return fail('action "upload" requires "ref" and "path" (a repo file)');
        // Only files inside the repo: the page could otherwise exfiltrate anything on disk.
        const file = await resolvePath(ctx, input.path, 'read');
        const backend = await session.getBackend();
        if (!backend.upload) return unsupported(backend, 'upload');
        const upload = backend.upload.bind(backend);
        const r = await withRefRetry(backend, ref, () => upload(ref, file));
        emit({ ref, path: input.path });
        return ok(`Uploaded ${basename(file)} to ${ref}${retried(r)}`);
      }

      case 'wait_for': {
        if (!input.ref && input.text === undefined) {
          return fail('action "wait_for" requires "ref" (element) or "text"');
        }
        const timeout = input.timeout_ms ?? DEFAULT_WAIT_MS;
        const backend = await session.getBackend();
        if (!backend.waitFor) return unsupported(backend, 'wait_for');
        const target = input.ref ? { selector: input.ref } : { text: input.text ?? '' };
        const what = input.ref ?? `"${input.text ?? ''}"`;
        try {
          await backend.waitFor(target, timeout);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          const snap = await backend.snapshot().catch(() => '');
          return fail(
            `${what} did not appear within ${timeout}ms (${why}). Check the snapshot below: the action that should reveal it may have failed, or the ref/text differs.\n\n${trimSnapshot(snap, RETRY_SNAPSHOT_TOKENS)}`,
          );
        }
        emit({ target: what });
        return ok(`${what} is on the page`);
      }

      case 'get_text': {
        const ref = needRef();
        const backend = await session.getBackend();
        if (!backend.getText) return unsupported(backend, 'get_text');
        const getText = backend.getText.bind(backend);
        let text = '';
        await withRefRetry(backend, ref, async () => {
          text = await getText(ref);
        });
        emit({ ref });
        return ok(clip(text));
      }

      case 'get_url': {
        const backend = await session.getBackend();
        if (!backend.getUrl) return unsupported(backend, 'get_url');
        const url = await backend.getUrl();
        emit({});
        return ok(url);
      }

      case 'eval': {
        // Page JS can mutate state, submit forms, or read cookies: off unless the config opts in.
        const verdict = checkBrowserToolPolicy('eval', { allowEval: config.allow_eval });
        if (!verdict.allowed) {
          return fail(
            `eval is disabled (${verdict.reason ?? verdict.rule ?? 'policy'}); set [browser] allow_eval = true to enable it, or use get_text/get_url/snapshot`,
          );
        }
        if (!input.expression) return fail('action "eval" requires "expression"');
        const backend = await session.getBackend();
        if (!backend.evaluate) return unsupported(backend, 'eval');
        const result = await backend.evaluate(input.expression);
        emit({});
        return ok(clip(result === undefined ? 'undefined' : JSON.stringify(result)));
      }

      case 'network': {
        const backend = await session.getBackend();
        if (!backend.network) return unsupported(backend, 'network');
        if (input.clear) {
          if (!backend.clearNetwork) return unsupported(backend, 'network with clear');
          await backend.clearNetwork();
          session.forgetNetwork();
          emit({ cleared: true });
          return ok('Network log cleared.');
        }
        const all = await backend.network();
        const reqs = input.failed_only ? all.filter(isFailedRequest) : all;
        emit({ count: reqs.length });
        if (reqs.length === 0) {
          return ok(
            input.failed_only ? 'No failed requests recorded.' : 'No network requests recorded.',
          );
        }
        const failed = all.filter(isFailedRequest).length;
        const shown = reqs.slice(-(input.limit ?? MAX_LIST_ITEMS));
        const dropped = reqs.length - shown.length;
        const lines = shown.map(
          (r) =>
            `${r.status ?? (r.failure ? `FAILED (${r.failure})` : 'FAILED')} ${r.method} ${r.url}${r.resourceType ? ` (${r.resourceType})` : ''}`,
        );
        const header = input.failed_only
          ? `Failed requests (${reqs.length}):`
          : `Requests (${reqs.length}, ${failed} failed):`;
        return ok(
          `${header}\n${[...(dropped > 0 ? [`… ${dropped} earlier entries omitted`] : []), ...lines].join('\n')}`,
        );
      }

      case 'diagnostics': {
        const backend = await session.getBackend();
        const [logs, reqs] = await Promise.all([
          backend.console(),
          backend.network ? backend.network() : Promise.resolve([] as BrowserRequest[]),
        ]);
        const d = collectBrowserDiagnostics(
          { console: logs, requests: reqs },
          { limit: input.limit ?? 20 },
        );
        const url = backend.getUrl ? await backend.getUrl().catch(() => '') : '';
        emitDiagnostics(ctx, d, url);
        return ok(
          hasDiagnostics(d)
            ? `${formatBrowserDiagnostics(d, { heading: `Browser diagnostics for ${url || 'the current page'}` })}\n\nFix these before calling the UI done; then re-check with check_page or visual_check.`
            : `Browser diagnostics for ${url || 'the current page'}: no console errors and no failed requests.`,
        );
      }

      case 'console': {
        const backend = await session.getBackend();
        if (input.clear) {
          if (!backend.clearConsole) return unsupported(backend, 'console with clear');
          await backend.clearConsole();
          session.forgetConsole();
          emit({ cleared: true });
          return ok('Console messages cleared.');
        }
        const logs = await backend.console();
        const level = input.level ?? 'all';
        const filtered =
          level === 'all'
            ? logs
            : logs.filter(
                (l) =>
                  l.type === 'error' ||
                  l.type === 'pageerror' ||
                  l.type === 'assert' ||
                  (level === 'warning' && l.type === 'warning'),
              );
        emit({ count: filtered.length });
        if (filtered.length === 0) {
          return ok(
            level === 'all'
              ? 'No console messages recorded.'
              : `No console ${level === 'error' ? 'errors' : 'warnings or errors'} recorded.`,
          );
        }
        const cap = input.limit ?? MAX_LIST_ITEMS;
        const shown = filtered.slice(-cap);
        const dropped = filtered.length - shown.length;
        const lines = shown.map(
          (l) => `[${l.type}] ${l.text}${l.location ? ` (${l.location})` : ''}`,
        );
        return ok(
          `Console messages (${filtered.length})${level === 'all' ? '' : ` matching ${level}`}:\n${[...(dropped > 0 ? [`… ${dropped} earlier entries omitted`] : []), ...lines].join('\n')}`,
        );
      }

      case 'tabs': {
        const backend = await session.getBackend();
        if (!backend.tabs) return unsupported(backend, 'tabs');
        const tabs = await backend.tabs();
        emit({ count: tabs.length });
        return ok(
          capList(
            tabs.map(
              (t) => `${t.active ? '*' : ' '} ${t.id}  ${t.url}${t.title ? `  "${t.title}"` : ''}`,
            ),
          ),
        );
      }

      case 'switch_tab': {
        if (!input.tab)
          return fail('action "switch_tab" requires "tab" (an id from action="tabs")');
        const backend = await session.getBackend();
        if (!backend.switchTab) return unsupported(backend, 'switch_tab');
        await backend.switchTab(input.tab);
        emit({ tab: input.tab });
        const url = backend.getUrl ? ` (${await backend.getUrl()})` : '';
        return ok(`Switched to tab ${input.tab}${url}`);
      }

      case 'new_tab': {
        const url = await checkUrl(input.url);
        if (typeof url !== 'string') return url;
        await session.ensureDevServerForUrl(url);
        const backend = await session.getBackend();
        if (!backend.newTab) return unsupported(backend, 'new_tab');
        await session.resetDiagnostics();
        await backend.newTab(url);
        await settle(backend);
        emit({ url });
        return ok(
          `Opened ${url} in a new tab\n\nSnapshot:\n${trimSnapshot(await backend.snapshot())}`,
        );
      }

      case 'close_tab': {
        const backend = await session.getBackend();
        if (!backend.closeTab) return unsupported(backend, 'close_tab');
        await backend.closeTab(input.tab);
        emit({ tab: input.tab ?? 'current' });
        return ok(`Closed tab ${input.tab ?? '(current)'}`);
      }

      case 'press': {
        if (!input.key) {
          return fail('action "press" requires "key" parameter');
        }
        const backend = await session.getBackend();
        await backend.press(input.key);
        emit({ key: input.key });
        return ok(`Pressed key ${input.key}`);
      }

      case 'scroll': {
        const backend = await session.getBackend();
        await backend.scroll(input.direction ?? 'down');
        emit({ direction: input.direction ?? 'down' });
        return ok(`Scrolled ${input.direction ?? 'down'}`);
      }

      case 'screenshot': {
        const backend = await session.getBackend();
        if (input.ref) {
          if (!backend.screenshotElement) return unsupported(backend, 'screenshot with ref');
          const shot = await backend.screenshotElement(input.ref);
          const buf = Buffer.from(shot.base64, 'base64');
          const dir = join(ctx.store.logsDir, 'browser');
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const file = join(dir, `element-${ctx.cycle}-${Date.now()}.png`);
          await writeFile(file, buf, { mode: 0o600 });
          emit({ path: file, ref: input.ref });
          return ok(
            `Screenshot of ${input.ref} saved to ${file} (${pngSize(buf)}, ${Math.round(buf.length / 1024)} KB). It is outside the repo.`,
          );
        }
        const { file, info } = await saveScreenshot(ctx, backend);
        const url = backend.getUrl ? await backend.getUrl().catch(() => '') : '';
        emit({ path: file });
        return ok(
          `Screenshot saved to ${file} (${info}${url ? `, of ${url}` : ''}). It is outside the repo; use snapshot or get_text to read what the page says.`,
        );
      }

      case 'start_server': {
        const command = input.command ?? config.serve;
        if (!command) {
          return fail(
            'start_server needs "command" (or set browser.serve in omnexx.toml), e.g. "npm run dev"',
          );
        }
        const verdict = checkCommand(command, ctx.policy);
        const allowed =
          verdict.allowed ||
          (ctx.ask !== undefined &&
            (await ctx.ask(
              `start dev server \`${command}\`? Normally refused: ${verdict.reason}`,
            )));
        if (!verdict.allowed && !allowed) {
          return fail(`refused by policy (${verdict.rule}): ${verdict.reason}`);
        }
        const port = input.port ?? config.serve_port;
        if (port !== undefined && (port < 1 || port > 65_535)) {
          return fail(`invalid port ${String(port)}`);
        }
        try {
          const status = await session.startDevServer(command, port);
          emit({ command, port, running: status.running });
          const output = status.output.trim();
          return ok(
            `Dev server running: \`${command}\`${port !== undefined ? ` on http://localhost:${String(port)}` : ''}.${output ? `\n\nOutput:\n${clip(output, 2_000)}` : ''}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit({ command, port, running: false });
          return fail(`dev server failed to start: ${msg}`);
        }
      }

      case 'stop_server': {
        await session.stopDevServer();
        emit({ running: false });
        return ok('Dev server stopped.');
      }

      case 'server_status': {
        const status = session.devServerStatus();
        if (!status) return ok('No dev server started by this session.');
        emit({ running: status.running, port: status.port });
        const output = status.output.trim();
        return ok(
          `Dev server ${status.running ? 'running' : 'stopped'}: \`${status.command}\`${status.port !== undefined ? ` on http://localhost:${String(status.port)}` : ''}${status.exitCode !== undefined ? ` (exit ${String(status.exitCode)})` : ''}.${output ? `\n\nRecent output:\n${clip(output, 2_000)}` : ''}`,
        );
      }

      case 'visual_check': {
        const name = input.name;
        if (!name) {
          return fail(
            'visual_check needs "name" (a stable label such as "home" or "checkout-button")',
          );
        }
        const backend = await session.getBackend();
        if (input.width !== undefined && input.height !== undefined && !backend.setViewport) {
          return unsupported(backend, 'visual_check with width and height');
        }
        if (input.width !== undefined) {
          await backend.setViewport?.(input.width, input.height ?? CHECK_HEIGHT);
        }
        const current = await captureVisual(backend, input.ref);
        const paths = visualPaths(ctx, name);
        const thresholdPct = Math.min(
          100,
          Math.max(0, input.threshold ?? config.visual_diff_threshold),
        );
        const threshold = thresholdPct / 100;

        if (input.update === true) {
          await writeUnderLogs(paths.baseline, current);
          ctx.events.emit('browser.visual', {
            action: 'baseline',
            name,
            pass: true,
            changedPixels: 0,
            totalPixels: 0,
            changedRatio: 0,
            width: pngWidth(current),
            height: pngHeight(current),
            baseline: paths.baseline,
            current: paths.baseline,
          });
          emit({ name, update: true });
          return ok(
            `Baseline "${name}" saved (${pngSize(current)}) to ${paths.baseline}. Later visual_check calls compare against it.`,
          );
        }

        const baseline = await readBaseline(paths.baseline);
        if (!baseline) {
          await writeUnderLogs(paths.baseline, current);
          ctx.events.emit('browser.visual', {
            action: 'baseline',
            name,
            pass: true,
            changedPixels: 0,
            totalPixels: 0,
            changedRatio: 0,
            width: pngWidth(current),
            height: pngHeight(current),
            baseline: paths.baseline,
            current: paths.baseline,
          });
          emit({ name, baseline: true });
          return ok(
            `First visual_check for "${name}": baseline saved (${pngSize(current)}) to ${paths.baseline}. Change the UI, then call visual_check with the same name to verify it.`,
          );
        }

        const diff = diffPng(baseline, current, {
          changeThreshold: threshold,
          includeDiff: true,
        });
        await writeUnderLogs(paths.current, current);
        if (diff.changedPixels > 0 && diff.diffPng) {
          await writeUnderLogs(paths.diff, diff.diffPng);
        }
        const summary = summarizeDiff(diff);
        ctx.events.emit(
          'browser.visual',
          visualEvent(name, summary, {
            baseline: paths.baseline,
            current: paths.current,
            ...(diff.changedPixels > 0 && diff.diffPng ? { diff: paths.diff } : {}),
          }),
        );
        emit({ name, pass: diff.pass, changedRatio: diff.changedRatio });
        const verdict = formatDiff(`visual_check "${name}"`, diff, threshold);
        const files = `Baseline: ${paths.baseline}\nCurrent: ${paths.current}${diff.changedPixels > 0 && diff.diffPng ? `\nDiff (red = changed): ${paths.diff}` : ''}`;
        return diff.pass
          ? ok(`${verdict}. No meaningful visual change.\n${files}`)
          : fail(
              `${verdict}. The UI moved or changed. Inspect the diff image, fix the layout, or pass update: true if the change is intended.\n${files}`,
            );
      }

      case 'check_page': {
        const backend = await session.getBackend();
        let target = input.url;
        if (target !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          // A repo file: only inside the jail, so the page can't be pointed at anything else.
          target = pathToFileURL(await resolvePath(ctx, target, 'read')).href;
        } else if (target !== undefined) {
          const url = await checkUrl(target);
          if (typeof url !== 'string') return url;
          await session.ensureDevServerForUrl(url);
        }
        if (input.width !== undefined) {
          if (!backend.setViewport) return unsupported(backend, 'check_page with width');
          await backend.setViewport(input.width, CHECK_HEIGHT);
        }
        // Only what this load logs counts; earlier pages' messages stay out of the report.
        const consoleBefore = target ? (await backend.console()).length : 0;
        const netBefore = target && backend.network ? (await backend.network()).length : 0;
        if (target) {
          await backend.open(target);
          await settle(backend);
        }
        const { file, info } = await saveScreenshot(ctx, backend);
        const layout = backend.evaluate
          ? asLayoutReport(await backend.evaluate(LAYOUT_PROBE).catch(() => null))
          : null;
        const url = target ?? (backend.getUrl ? await backend.getUrl().catch(() => '') : '');
        emit({ url, path: file });
        return ok(
          formatPageCheck({
            url,
            screenshot: `${file} (${info})`,
            console: (await backend.console()).slice(consoleBefore),
            requests: backend.network ? (await backend.network()).slice(netBefore) : [],
            layout,
          }),
        );
      }

      case 'close': {
        ctx.events.emit('browser.close', { runId: ctx.store.runId });
        await closeSession(ctx.store.runId);
        return ok('Browser session closed.');
      }
    }
  }

  return {
    name: 'browser',
    description:
      'Headless browser to inspect, drive and verify web apps. Use refs from the latest snapshot or text=/role= targets; wait_for after actions that load content. start_server/stop_server run a dev server; open a localhost URL. console (level, clear), network (failed_only) and diagnostics report frontend errors and 4xx/5xx failures, which are also appended after page-changing actions. visual_check(name) captures a screenshot (or element with ref) and compares it to the stored baseline; use it before and after UI changes at phone width (width: 375) to catch layout regressions. check_page reports screenshot, console, failed requests and layout problems. Only URLs in browser.allow.',
    schema: browserActionSchema,
    readOnly: false,
    async run(input: BrowserActionInput, ctx: ToolContext): Promise<ToolOutput> {
      const session = getOrCreateSession(ctx.store.runId, config, ctx.jail.root, {
        ...(opts.createBackend ? { createBackend: opts.createBackend } : {}),
        ...(opts.createDevServer ? { createDevServer: opts.createDevServer } : {}),
      });
      try {
        const out = await run(input, ctx, session);
        if (!out.isError && config.report_errors && DIAGNOSTIC_ACTIONS.has(input.action)) {
          const d = await session.newDiagnostics().catch(() => null);
          if (d) {
            const backend = await session.getBackend().catch(() => null);
            const url = backend?.getUrl ? await backend.getUrl().catch(() => '') : '';
            emitDiagnostics(ctx, d, url, input.action);
            out.content = `${out.content}\n\n${diagnosticsNote(d)}`;
          }
        }
        if (config.live_view && PAGE_CHANGING.has(input.action) && !out.isError)
          await liveFrame(ctx, session, input.action);
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof UsageError || err instanceof StaleRefError) return fail(msg);
        if (input.ref && TIMEOUT.test(msg)) return fail(await timeoutHelp(session, input, msg));
        if (FATAL.test(msg)) {
          await closeSession(ctx.store.runId);
          return fail(
            `browser ${input.action} failed: ${msg}\nThe browser session was closed; the next action starts a fresh one (open the page again).`,
          );
        }
        return fail(`browser ${input.action} failed: ${msg}`);
      }
    },
  };
}

export const source: ToolSource = {
  async load(config: OmnexxConfig): Promise<readonly Tool[]> {
    if (!config.browser.enabled) {
      return [];
    }

    const detected = await detectBrowserBackend();
    if (!detected.backend) {
      return [];
    }

    return [createBrowserTool(config.browser)];
  },
};
