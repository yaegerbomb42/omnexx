import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { OmnexxConfig } from '../../config/schema.js';
import { checkBrowserToolPolicy } from '../../security/policy-extra.js';
import type { ToolSource } from '../extra/types.js';
import { fail, ok, resolvePath, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import { detectBrowserBackend } from './browser/detector.js';
import { BrowserSessionManager, type BrowserManagerOptions } from './browser/manager.js';
import { isUrlAllowed } from './browser/security.js';
import { trimSnapshot } from './browser/snapshot.js';
import type { BrowserBackend } from './browser/types.js';

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
  'tabs',
  'switch_tab',
  'new_tab',
  'close_tab',
  'screenshot',
  'console',
  'close',
] as const;

const browserActionSchema = z.strictObject({
  action: z.enum(ACTIONS).describe('The browser action to perform'),
  url: z.string().optional().describe('URL to navigate to (for open and new_tab)'),
  ref: z
    .string()
    .optional()
    .describe(
      'Element reference from the latest snapshot (e.g. "@e1") or a CSS selector, for click/type/fill/hover/select/check/uncheck/upload/get_text/wait_for',
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
  createBackend?: BrowserManagerOptions['createBackend'],
): BrowserSessionManager {
  let session = activeSessions.get(runId);
  if (!session) {
    session = new BrowserSessionManager({
      runId,
      config,
      worktreeRoot,
      ...(createBackend ? { createBackend } : {}),
    });
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
function pngSize(buf: Buffer): string {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return 'unknown size';
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

const unsupported = (backend: BrowserBackend, action: string): ToolOutput =>
  fail(
    `action "${action}" is not supported by the ${backend.name} browser backend; use snapshot and the core actions (open, click, type, press) instead`,
  );

export interface BrowserToolOptions {
  /** Tests inject a fake backend; default: detect one. */
  createBackend?: BrowserManagerOptions['createBackend'];
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
    const checkUrl = (url: string | undefined): string | ToolOutput => {
      if (!url) return fail(`action "${input.action}" requires "url" parameter`);
      if (!isUrlAllowed(url, config.allow)) {
        ctx.events.emit('browser.denied', {
          url,
          allow: config.allow,
          reason: `URL ${url} is not permitted by browser.allow allowlist`,
        });
        return fail(`URL "${url}" is refused by browser allowlist (${config.allow.join(', ')})`);
      }
      return url;
    };
    const retried = (r: boolean): string => (r ? ' (after refreshing a stale ref)' : '');

    switch (input.action) {
      case 'open': {
        const url = checkUrl(input.url);
        if (typeof url !== 'string') return url;
        await session.ensureDevServerForUrl(url);
        const backend = await session.getBackend();
        await backend.open(url);
        await settle(backend);
        ctx.events.emit('browser.open', { url, backend: backend.name });
        const snap = await backend.snapshot();
        return ok(`Opened ${url}\n\nSnapshot:\n${trimSnapshot(snap)}`);
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
        const reqs = await backend.network();
        emit({ count: reqs.length });
        if (reqs.length === 0) return ok('No network requests recorded.');
        const failed = reqs.filter((r) => r.status === undefined || r.status >= 400).length;
        const lines = reqs.map(
          (r) =>
            `${r.status ?? 'FAILED'} ${r.method} ${r.url}${r.resourceType ? ` (${r.resourceType})` : ''}`,
        );
        return ok(`Requests (${reqs.length}, ${failed} failed):\n${capList(lines)}`);
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
        const url = checkUrl(input.url);
        if (typeof url !== 'string') return url;
        await session.ensureDevServerForUrl(url);
        const backend = await session.getBackend();
        if (!backend.newTab) return unsupported(backend, 'new_tab');
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
        const shot = await backend.screenshot();
        // Under the run's logs, never the repo: screenshots must not end up in a commit.
        const dir = join(ctx.store.logsDir, 'browser');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const ext = shot.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const file = join(dir, `screenshot-${ctx.cycle}-${Date.now()}.${ext}`);
        const buf = Buffer.from(shot.base64, 'base64');
        await writeFile(file, buf, { mode: 0o600 });
        const url = backend.getUrl ? await backend.getUrl().catch(() => '') : '';
        emit({ path: file });
        return ok(
          `Screenshot saved to ${file} (${ext === 'png' ? pngSize(buf) : 'jpeg'}, ${Math.round(buf.length / 1024)} KB${url ? `, of ${url}` : ''}). It is outside the repo; use snapshot or get_text to read what the page says.`,
        );
      }

      case 'console': {
        const backend = await session.getBackend();
        const logs = await backend.console();
        emit({ count: logs.length });
        if (logs.length === 0) {
          return ok('No console messages recorded.');
        }
        return ok(
          `Console messages (${logs.length}):\n${capList(logs.map((l) => `[${l.type}] ${l.text}`))}`,
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
    description: `Control a headless browser to inspect, interact with, and verify web applications. Actions: ${ACTIONS.join(', ')}. Use refs from the latest snapshot; use wait_for after actions that load content. Refuses URLs outside the browser.allow allowlist.`,
    schema: browserActionSchema,
    readOnly: false,
    async run(input: BrowserActionInput, ctx: ToolContext): Promise<ToolOutput> {
      const session = getOrCreateSession(
        ctx.store.runId,
        config,
        ctx.jail.root,
        opts.createBackend,
      );
      try {
        return await run(input, ctx, session);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof UsageError || err instanceof StaleRefError) return fail(msg);
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
