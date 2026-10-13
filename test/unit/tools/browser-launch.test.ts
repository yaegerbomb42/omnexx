import { describe, expect, it } from 'vitest';
import { AgentBrowserBackend } from '../../../src/tools/extra/browser/agent-browser.js';
import { createBrowserBackend } from '../../../src/tools/extra/browser/detector.js';
import { BrowserSessionManager } from '../../../src/tools/extra/browser/manager.js';
import { PlaywrightBackend } from '../../../src/tools/extra/browser/playwright.js';
import type { BrowserLaunch } from '../../../src/tools/extra/browser/types.js';
import { browser } from '../../../src/config/sections/browser.js';

const stateArgs = (b: AgentBrowserBackend) => (b as unknown as { stateArgs: string[] }).stateArgs;

describe('browser launch options', () => {
  it('agent-browser reuses a profile and a saved session on every command', () => {
    expect(stateArgs(new AgentBrowserBackend('s', true))).toEqual([]);
    expect(
      stateArgs(
        new AgentBrowserBackend('s', { headless: true, profile: 'Default', sessionName: 'work' }),
      ),
    ).toEqual(['--profile', 'Default', '--session-name', 'work']);
  });

  it('camoufox always goes to Playwright and explains how to install it when missing', async () => {
    const b = await createBrowserBackend('s', true, { engine: 'camoufox' });
    expect(b).toBeInstanceOf(PlaywrightBackend);
    await expect(b?.open('http://localhost:1')).rejects.toThrow(/camoufox-js fetch/);
  });

  it('the session manager hands engine, profile and session name to the backend', async () => {
    const seen: Partial<BrowserLaunch>[] = [];
    const m = new BrowserSessionManager({
      runId: 'r1',
      worktreeRoot: '/tmp',
      config: browser.parse({ engine: 'camoufox', profile: '/tmp/p', session_name: 'work' }),
      createBackend: (_s, _h, launch) => {
        seen.push(launch);
        return Promise.resolve(new PlaywrightBackend(true));
      },
    });
    await m.getBackend();
    expect(seen).toEqual([{ engine: 'camoufox', profile: '/tmp/p', sessionName: 'work' }]);
    expect(() => browser.parse({ session_name: 'bad name!' })).toThrow();
  });
});
