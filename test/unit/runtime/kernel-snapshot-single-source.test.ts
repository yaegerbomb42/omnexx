import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('bug #14: one committed registry snapshot', () => {
  it('copy script targets only dist/data and package files no longer ship root data/', () => {
    const script = readFileSync(join(root, 'scripts', 'copy-kernel-data.mjs'), 'utf8');
    expect(script).not.toMatch(/join\(root, 'data'/);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).not.toContain('data');
    expect(
      existsSync(join(root, 'src', 'runtime', 'kernel', 'data', 'mcp-registry-snapshot.json.gz')),
    ).toBe(true);
  });
});
