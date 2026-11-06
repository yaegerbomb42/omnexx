import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, validateRegistrySnapshot } from '../../../src/runtime/kernel/registry.js';

describe('bug #20: registry snapshot integrity', () => {
  it('rejects truncated / malformed snapshots', () => {
    const ok = {
      fetchedAt: new Date().toISOString(),
      latestCount: 1,
      servers: [{ id: 'a', server: 'x/a', name: 'a' }],
    };
    expect(() => validateRegistrySnapshot(ok)).not.toThrow();
    expect(() => validateRegistrySnapshot({ ...ok, latestCount: 5 })).toThrow(/truncated/);
    expect(() => validateRegistrySnapshot({ ...ok, servers: [{ id: 1 }] })).toThrow(/malformed/);
    expect(() => validateRegistrySnapshot({ fetchedAt: 'x', servers: [] })).toThrow(/fetchedAt/);
  });

  it('reports a corrupt cache file instead of silently skipping it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omnexx-corrupt-'));
    const dir = join(home, 'omnexx', 'cache');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'mcp-registry-snapshot.json.gz'), gzipSync('{"servers": [ {"id"'));
    const r = await loadRegistry({ offline: true, env: { OMNEXX_CONFIG_HOME: home } });
    expect(r.from).toBe('bundled');
    expect(r.issues?.some((i) => i.includes('mcp-registry-snapshot.json.gz'))).toBe(true);
  });
});
