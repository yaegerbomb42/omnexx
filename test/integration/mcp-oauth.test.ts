import { readFile, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpServerSchema } from '../../src/config/sections/mcp.js';
import { McpClientManager } from '../../src/mcp/client-manager.js';
import { signIn } from '../../src/mcp/login.js';
import { forgetLogin, hasTokens, oauthFile } from '../../src/mcp/oauth.js';
import { fakeBrowser, startFakeOAuthMcp, type FakeOAuthMcp } from '../support/fake-oauth-mcp.js';
import { tempDir } from '../support/tmp.js';

let fake: FakeOAuthMcp | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('MCP OAuth sign-in', () => {
  it('registers, signs in through the browser, stores tokens 0600, and runs use them without asking', async () => {
    // Arrange
    fake = await startFakeOAuthMcp();
    const home = await tempDir();
    const config = mcpServerSchema.parse({ url: fake.url, oauth: true });
    const opened: string[] = [];
    const log: string[] = [];

    // Act
    const tools = await signIn('fake', config, {
      configHome: home,
      open: (u) => {
        opened.push(u);
        void fakeBrowser(u);
      },
      log: (l) => log.push(l),
    });

    // Assert
    expect(tools).toBe(1);
    expect(fake.registered).toBe(1);
    expect(opened[0]).toMatch(/\/authorize\?.*code_challenge=/);
    expect(await hasTokens(home, 'fake')).toBe(true);
    expect((await stat(oauthFile(home))).mode & 0o777).toBe(0o600);
    expect(await readFile(oauthFile(home), 'utf8')).toContain('"client_id": "client-1"');

    const mgr = new McpClientManager({ fake: config }, { configHome: home, env: {} });
    try {
      expect((await mgr.listTools()).map((t) => t.name)).toEqual(['ping']);
    } finally {
      await mgr.closeAll();
    }
  });

  it('a second sign-in reuses the stored login without opening the browser', async () => {
    fake = await startFakeOAuthMcp();
    const home = await tempDir();
    const config = mcpServerSchema.parse({ url: fake.url, oauth: true });
    const deps = {
      configHome: home,
      open: (u: string) => void fakeBrowser(u),
      log: () => undefined,
    };
    await signIn('fake', config, deps);
    const opened: string[] = [];

    const tools = await signIn('fake', config, { ...deps, open: (u) => opened.push(u) });

    expect(tools).toBe(1);
    expect(opened).toEqual([]);
    expect(fake.registered).toBe(1);
  });

  it('forgetting the login drops the tokens', async () => {
    fake = await startFakeOAuthMcp();
    const home = await tempDir();
    const config = mcpServerSchema.parse({ url: fake.url, oauth: true });
    await signIn('fake', config, {
      configHome: home,
      open: (u) => void fakeBrowser(u),
      log: () => undefined,
    });

    await forgetLogin(home, 'fake');

    expect(await hasTokens(home, 'fake')).toBe(false);
  });
});
