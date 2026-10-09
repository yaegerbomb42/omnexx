import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextBreakdown } from '../../../src/core/cycle.js';
import { readTool } from '../../../src/tools/read.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

describe('read dedupe', () => {
  it('returns a pointer for an unchanged repeat read, full text after a change or a reset', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'one\ntwo\nthree\n');
    const ctx = await toolContext(root, { reads: new Map() });
    const first = await readTool.run({ path: 'src/a.ts' }, ctx);
    expect(first.content).toContain('    2  two');
    const again = await readTool.run({ path: 'src/a.ts' }, ctx);
    expect(again.content).toMatch(/unchanged since you read it earlier this cycle/);
    expect(again.content.length).toBeLessThan(first.content.length + 200);
    // A different range is a different read.
    expect((await readTool.run({ path: 'src/a.ts', start: 2, end: 2 }, ctx)).content).toContain(
      'two',
    );
    await writeFile(join(root, 'src/a.ts'), 'one\nTWO\nthree\n');
    expect((await readTool.run({ path: 'src/a.ts' }, ctx)).content).toContain('    2  TWO');
    ctx.reads?.clear();
    expect((await readTool.run({ path: 'src/a.ts' }, ctx)).content).toContain('    2  TWO');
  });

  it('never dedupes without a cache (planner and older callers)', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), 'x\n');
    const ctx = await toolContext(root);
    await readTool.run({ path: 'a.txt' }, ctx);
    expect((await readTool.run({ path: 'a.txt' }, ctx)).content).toContain('    1  x');
  });
});

describe('contextBreakdown', () => {
  it('labels the prefix blocks, tools and cycle state', () => {
    const b = contextBreakdown({
      system: [{ text: 'a'.repeat(400) }, { text: 'b'.repeat(800) }, { text: 'g' }, { text: 'n' }],
      first: { role: 'user', content: [{ type: 'text', text: 'plan' }] },
      tools: [{ name: 'read' }],
    });
    expect(Object.keys(b)).toEqual(['tools', 'system', 'codemap', 'goal', 'notes', 'state']);
    expect(b.codemap).toBeGreaterThan(b.system ?? 0);
  });
});

describe('cycle.context feed line', () => {
  it('shows the breakdown largest first in verbose', async () => {
    const { humanize } = await import('../../../src/telemetry/humanize.js');
    const { brand } = await import('../../../src/cli/brand.js');
    const line = humanize(
      {
        ts: 0,
        runId: 'r',
        cycle: 1,
        type: 'cycle.context',
        tokens: { tools: 2000, codemap: 3000, state: 500 },
      },
      { brand: brand({ env: {}, isTTY: false }), verbosity: 'verbose', clock: false },
    );
    expect(line).toBe('· ctx      5.5k: codemap 3.0k · tools 2.0k · state 500');
  });
});
