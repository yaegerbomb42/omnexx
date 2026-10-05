import { z } from 'zod';
import type { OmnexxConfig } from '../../config/schema.js';
import type { ToolSource } from '../extra/types.js';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import { detectBrowserBackend } from './browser/detector.js';
import { BrowserSessionManager } from './browser/manager.js';
import { isUrlAllowed } from './browser/security.js';
import { trimSnapshot } from './browser/snapshot.js';

const browserActionSchema = z.strictObject({
  action: z
    .enum([
      'open',
      'snapshot',
      'click',
      'type',
      'press',
      'scroll',
      'screenshot',
      'console',
      'close',
    ])
    .describe('The browser action to perform'),
  url: z.string().optional().describe('URL to navigate to (required for action="open")'),
  ref: z
    .string()
    .optional()
    .describe('Element reference (e.g. "@e1" or "e1") or selector for click/type'),
  text: z.string().optional().describe('Text to type (required for action="type")'),
  key: z.string().optional().describe('Key to press, e.g. "Enter", "Tab" (for action="press")'),
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('Direction to scroll (for action="scroll")'),
});

export type BrowserActionInput = z.infer<typeof browserActionSchema>;

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
): BrowserSessionManager {
  let session = activeSessions.get(runId);
  if (!session) {
    session = new BrowserSessionManager({
      runId,
      config,
      worktreeRoot,
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

export function createBrowserTool(
  config: OmnexxConfig['browser'],
): Tool<typeof browserActionSchema> {
  return {
    name: 'browser',
    description:
      'Control a headless browser to inspect, interact with, and verify web applications. Actions: open, snapshot, click, type, press, scroll, screenshot, console, close. Refuses disallowed URLs outside localhost/local domain allowlist.',
    schema: browserActionSchema,
    readOnly: false,
    async run(input: BrowserActionInput, ctx: ToolContext): Promise<ToolOutput> {
      const session = getOrCreateSession(ctx.store.runId, config, ctx.jail.root);

      try {
        switch (input.action) {
          case 'open': {
            if (!input.url) {
              return fail('action "open" requires "url" parameter');
            }
            if (!isUrlAllowed(input.url, config.allow)) {
              ctx.events.emit('browser.denied', {
                url: input.url,
                allow: config.allow,
                reason: `URL ${input.url} is not permitted by browser.allow allowlist`,
              });
              return fail(
                `URL "${input.url}" is refused by browser allowlist (${config.allow.join(', ')})`,
              );
            }

            await session.ensureDevServerForUrl(input.url);
            const backend = await session.getBackend();
            await backend.open(input.url);

            ctx.events.emit('browser.open', {
              url: input.url,
              backend: backend.name,
            });

            // Return snapshot immediately upon opening
            const snap = await backend.snapshot();
            const trimmed = trimSnapshot(snap);
            return ok(`Opened ${input.url}\n\nSnapshot:\n${trimmed}`);
          }

          case 'snapshot': {
            const backend = await session.getBackend();
            const snap = await backend.snapshot();
            const trimmed = trimSnapshot(snap);
            ctx.events.emit('browser.action', { action: 'snapshot' });
            return ok(trimmed);
          }

          case 'click': {
            if (!input.ref) {
              return fail('action "click" requires "ref" parameter');
            }
            const backend = await session.getBackend();
            await backend.click(input.ref);
            ctx.events.emit('browser.action', { action: 'click', ref: input.ref });
            return ok(`Clicked ${input.ref}`);
          }

          case 'type': {
            if (!input.ref || input.text === undefined) {
              return fail('action "type" requires "ref" and "text" parameters');
            }
            const backend = await session.getBackend();
            await backend.type(input.ref, input.text);
            ctx.events.emit('browser.action', { action: 'type', ref: input.ref, text: input.text });
            return ok(`Typed into ${input.ref}`);
          }

          case 'press': {
            if (!input.key) {
              return fail('action "press" requires "key" parameter');
            }
            const backend = await session.getBackend();
            await backend.press(input.key);
            ctx.events.emit('browser.action', { action: 'press', key: input.key });
            return ok(`Pressed key ${input.key}`);
          }

          case 'scroll': {
            const backend = await session.getBackend();
            await backend.scroll(input.direction ?? 'down');
            ctx.events.emit('browser.action', {
              action: 'scroll',
              direction: input.direction ?? 'down',
            });
            return ok(`Scrolled ${input.direction ?? 'down'}`);
          }

          case 'screenshot': {
            const backend = await session.getBackend();
            const shot = await backend.screenshot();
            ctx.events.emit('browser.action', { action: 'screenshot' });

            // Check if context / active model supports vision
            // (ctx as any).supportsVision flag
            const supportsVision = Boolean(
              (ctx as unknown as { supportsVision?: boolean }).supportsVision,
            );
            if (supportsVision) {
              return {
                content: `Screenshot captured (${shot.mimeType}):\ndata:${shot.mimeType};base64,${shot.base64}`,
              };
            }

            return ok(
              'Screenshot captured successfully. (Active model profile does not support vision; image data omitted. To view UI, use snapshot or a vision-enabled model).',
            );
          }

          case 'console': {
            const backend = await session.getBackend();
            const logs = await backend.console();
            ctx.events.emit('browser.action', { action: 'console', count: logs.length });
            if (logs.length === 0) {
              return ok('No console messages recorded.');
            }
            const formatted = logs.map((l) => `[${l.type}] ${l.text}`).join('\n');
            return ok(`Console messages (${logs.length}):\n${formatted}`);
          }

          case 'close': {
            ctx.events.emit('browser.close', { runId: ctx.store.runId });
            await closeSession(ctx.store.runId);
            return ok('Browser session closed.');
          }

          default:
            return fail(`Unknown browser action: ${String(input.action)}`);
        }
      } catch (err) {
        return fail(
          `browser ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
