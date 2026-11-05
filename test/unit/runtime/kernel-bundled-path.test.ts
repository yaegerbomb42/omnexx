import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundledCandidates, readBundledSnapshot } from '../../../src/runtime/kernel/registry.js';

const SNAP = join(
  process.cwd(),
  'src',
  'runtime',
  'kernel',
  'data',
  'mcp-registry-snapshot.json.gz',
);

describe('bug #13: bundled snapshot lookup', () => {
  it('has no duplicate candidates and does not depend on cwd', () => {
    const c = bundledCandidates(pathToFileURL('/opt/pkg/dist/chunk.js').href);
    expect(new Set(c).size).toBe(c.length);
    expect(c.every((p) => !p.startsWith(process.cwd()))).toBe(true);
  });

  it('finds dist/data from a global-install layout with an unrelated cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omnexx-pkg-'));
    await mkdir(join(root, 'dist', 'data'), { recursive: true });
    await copyFile(SNAP, join(root, 'dist', 'data', 'mcp-registry-snapshot.json.gz'));
    const snap = await readBundledSnapshot(
      pathToFileURL(join(root, 'dist', 'cli', 'index.js')).href,
    );
    expect(snap?.servers.length).toBeGreaterThan(100);
  });
});
