import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('package.json', () => {
  it('runtime dependencies match the approved list exactly (plan §5.5)', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
      bin: Record<string, string>;
      files: string[];
      engines: { node: string };
      type: string;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      [
        '@anthropic-ai/sdk',
        'commander',
        'execa',
        'ink',
        'picocolors',
        'react',
        'shell-quote',
        'smol-toml',
        'zod',
      ].sort(),
    );
    expect(pkg.bin).toEqual({ omnexx: 'dist/cli.js' });
    expect(pkg.files.sort()).toEqual(['LICENSE', 'README.md', 'dist']);
    expect(pkg.engines.node).toBe('>=22');
    expect(pkg.type).toBe('module');
  });
});
