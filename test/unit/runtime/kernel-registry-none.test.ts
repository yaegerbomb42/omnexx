import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegistry } from '../../../src/runtime/kernel/registry.js';

describe('bug #18: empty offline fallback is not reported as bundled', () => {
  it("reports from: 'none' when no snapshot exists anywhere", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omnexx-noreg-'));
    const result = await loadRegistry({
      offline: true,
      env: { OMNEXX_CONFIG_HOME: dir },
      moduleUrl: pathToFileURL(join(dir, 'a', 'b', 'mod.js')).href,
    });
    expect(result.entries).toEqual([]);
    expect(result.from).toBe('none');
  });
});
