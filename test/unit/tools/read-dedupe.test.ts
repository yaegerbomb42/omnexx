import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextBreakdown } from '../../../src/core/cycle.js';
import { estimateTokens } from '../../../src/core/tokens.js';
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
    expect(again.content).toMatch(
      /unchanged and lines 1-\d+ were already shown earlier this cycle/,
    );
    expect(again.content.length).toBeLessThan(first.content.length + 200);
    // A range inside what was already shown is answered from context, once...
    const inside = await readTool.run({ path: 'src/a.ts', start: 2, end: 2 }, ctx);
    expect(inside.content).toMatch(/lines 2-2 were already shown/);
    // ...and asking for exactly that again returns the lines (they may have been trimmed).
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

  it('says unchanged since step N, repeats the earlier note, and records the tokens saved', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'));
    const lines = Array.from(
      { length: 30 },
      (_, i) => `export const value${String(i)} = ${String(i)};`,
    );
    await writeFile(join(root, 'src/a.ts'), `${lines.join('\n')}\n`);
    const waste: { tokens: number; path?: string; sinceStep?: number }[] = [];
    const ctx = await toolContext(root, { reads: new Map(), step: 2 });
    ctx.onWaste = (w) => waste.push(w);
    const first = await readTool.run({ path: 'src/a.ts', note: 'the exports I need' }, ctx);
    expect(first.content).toContain('export const value0');

    ctx.step = 5;
    const again = await readTool.run({ path: 'src/a.ts' }, ctx);
    expect(again.content).toContain('unchanged since step 2');
    expect(again.content).toContain('Earlier note: the exports I need');
    expect(again.content.length).toBeLessThan(first.content.length);
    expect(waste).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        sinceStep: 2,
        tokens: expect.any(Number) as unknown as number,
      }),
    ]);
    expect(waste[0]?.tokens).toBeGreaterThan(0);
  });

  it('cuts a read-heavy workload by at least a fifth of its input tokens', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'));
    // A file big enough that a repeat read is a real fraction of a turn's prompt.
    const lines = Array.from(
      { length: 350 },
      (_, i) => `export const value${String(i)} = ${String(i)};`,
    );
    await writeFile(join(root, 'src/big.ts'), `${lines.join('\n')}\n`);
    const guarded = await toolContext(root, { reads: new Map(), step: 1 });
    const plain = await toolContext(root);
    let guardedTokens = 0;
    let plainTokens = 0;
    for (let turn = 0; turn < 12; turn++) {
      guarded.step = turn + 1;
      const withGuard = await readTool.run({ path: 'src/big.ts' }, guarded);
      const without = await readTool.run({ path: 'src/big.ts' }, plain);
      guardedTokens += estimateTokens(withGuard.content);
      plainTokens += estimateTokens(without.content);
    }
    // 1 full read + 11 pointers instead of 12 full reads: the benchmark target is 20%.
    expect(guardedTokens).toBeLessThanOrEqual(plainTokens * 0.8);
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
