import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSecrets, secretsFile, writeServerSecrets } from '../../../src/integrations/secrets.js';
import { forgetLogin, hasTokens, oauthFile } from '../../../src/mcp/oauth.js';
import { QuotaStore } from '../../../src/workers/quota.js';
import type { QuotaPolicy, WorkerStatus } from '../../../src/workers/types.js';
import { tempDir } from '../../support/tmp.js';

const policy: QuotaPolicy = { maxRunsPerHour: 10, maxRunsPerDay: 50, cooldownMs: 1_000 };

describe('corrupt mcp-secrets.json', () => {
  it('writeServerSecrets refuses to wipe other entries when the file is truncated mid-object', async () => {
    // Arrange: a truncated secrets file that would fail JSON.parse
    const home = await tempDir();
    await mkdir(home, { recursive: true });
    await writeFile(secretsFile(home), '{"srvA": {"KEY_A": "aaa",', 'utf8');

    // Act: writing a new server's secrets must raise, not silently replace everything
    await expect(writeServerSecrets(home, 'srvC', { KEY_C: 'ccc' })).rejects.toThrow();

    // Assert: a corrupt backup exists, and the secrets file was not replaced with only srvC
    const entries = await readdir(home);
    const corrupt = entries.filter((e) => e.startsWith('mcp-secrets.json.corrupt-'));
    expect(corrupt).toHaveLength(1);
    let backup = '';
    for (const e of corrupt) backup = join(home, e);
    expect(await readFile(backup, 'utf8')).toBe('{"srvA": {"KEY_A": "aaa",');
    // The live file no longer holds corrupt (or overwritten) content; reads start fresh
    await expect(readSecrets(home)).resolves.toEqual({});
  });

  it('readSecrets raises on a corrupt file rather than silently returning an empty map', async () => {
    const home = await tempDir();
    await writeFile(secretsFile(home), 'not json at all{', 'utf8');
    await expect(readSecrets(home)).rejects.toThrow();
    expect((await readdir(home)).some((e) => e.startsWith('mcp-secrets.json.corrupt-'))).toBe(true);
  });

  it('readSecrets still returns {} when the file is absent', async () => {
    const home = await tempDir();
    await expect(readSecrets(home)).resolves.toEqual({});
  });

  it('writeServerSecrets preserves other servers and writes atomically with 0600 mode', async () => {
    const home = await tempDir();
    await writeServerSecrets(home, 'srvA', { KEY_A: 'aaa' });
    await writeServerSecrets(home, 'srvC', { KEY_C: 'ccc' });

    expect(await readSecrets(home)).toEqual({
      srvA: { KEY_A: 'aaa' },
      srvC: { KEY_C: 'ccc' },
    });
    expect((await stat(secretsFile(home))).mode & 0o777).toBe(0o600);
    // atomic writes leave no stray tmp files behind
    expect((await readdir(home)).filter((e) => e.includes('.tmp'))).toEqual([]);
  });
});

describe('corrupt mcp-oauth.json', () => {
  it('hasTokens/forgetLogin raise instead of wiping other logins when the file is corrupt', async () => {
    // Arrange
    const home = await tempDir();
    await writeFile(oauthFile(home), 'this is not json{{{', 'utf8');

    // Act / Assert: reading and writing both surface the corruption
    await expect(hasTokens(home, 'srvA')).rejects.toThrow();
    await writeFile(oauthFile(home), 'this is not json{{{', 'utf8'); // hasTokens renamed it away
    await expect(forgetLogin(home, 'srvB')).rejects.toThrow();

    // The corrupt payload is preserved in a backup file
    const entries = await readdir(home);
    const backups = entries.filter((e) => e.startsWith('mcp-oauth.json.corrupt-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    let verified = false;
    for (const e of backups) {
      if ((await readFile(join(home, e), 'utf8')) === 'this is not json{{{') {
        verified = true;
        break;
      }
    }
    expect(verified).toBe(true);
  });

  it('saveTokens on a corrupt file raises and leaves a backup', async () => {
    const { McpOAuthProvider } = await import('../../../src/mcp/oauth.js');
    const home = await tempDir();
    await writeFile(oauthFile(home), 'this is not json{{{', 'utf8');
    const provider = new McpOAuthProvider(home, 'srvX');

    await expect(provider.saveTokens({ access_token: 't' } as never)).rejects.toThrow();
    expect((await readdir(home)).some((e) => e.startsWith('mcp-oauth.json.corrupt-'))).toBe(true);
  });

  it('valid logins still round-trip through the atomic write', async () => {
    const { McpOAuthProvider } = await import('../../../src/mcp/oauth.js');
    const home = await tempDir();
    const provider = new McpOAuthProvider(home, 'srv');
    await provider.saveTokens({ access_token: 't' } as never);

    expect(await hasTokens(home, 'srv')).toBe(true);
    expect((await stat(oauthFile(home))).mode & 0o777).toBe(0o600);
  });
});

describe('corrupt workers/state.json', () => {
  it('blocked() and record() do not throw on invalid JSON and can recover afterwards', async () => {
    // Arrange: a QuotaStore whose state.json is not JSON at all
    const home = await tempDir();
    const store = new QuotaStore(home);
    await mkdir(join(home, 'workers'), { recursive: true });
    await writeFile(store.path, 'this is not json{{{', 'utf8');

    // Act / Assert: reads degrade to empty, not a crash
    await expect(store.blocked('w1', policy, 1_000)).resolves.toBeUndefined();
    await expect(
      store.record('w1', 'running' as WorkerStatus, policy, 1_000),
    ).resolves.toBeUndefined();

    // After record() rewrites the file atomically, the store is usable again
    await expect(store.blocked('w1', policy, 2_000)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual({
      w1: { runs: [1_000], lastStatus: 'running' },
    });
  });
});
