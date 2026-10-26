import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextBreakdown } from '../../../src/core/cycle.js';
import { readTool } from '../../../src/tools/read.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

describe('read dedupe', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a step-stamped note with the earlier note for an unchanged repeat read', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'one\ntwo\nthree\n');
    const ctx = await toolContext(root, { reads: new Map(), turn: 1 });
    const first = await readTool.run(
      { path: 'src/a.ts', note: 'TWO is the constant the bug touches' },
      ctx,
    );
    expect(first.content).toContain('    2  two');
    expect(first.savedTokens).toBeUndefined();
    ctx.turn = 2;
    const again = await readTool.run({ path: 'src/a.ts' }, ctx);
    expect(again.content).toMatch(/unchanged since step 1/);
    expect(again.content).toContain('your earlier note: "TWO is the constant the bug touches"');
    expect(again.content).not.toContain('    2  two');
    expect(again.savedTokens).toBeGreaterThan(0);
    expect(again.content.length).toBeLessThan(first.content.length + 200);
    // A range inside what was already shown is answered from context too.
    const inside = await readTool.run({ path: 'src/a.ts', start: 2, end: 2 }, ctx);
    expect(inside.content).toMatch(/lines 2-2 were already shown/);
    // The same range again is still a note; refresh asks for the bytes explicitly.
    expect((await readTool.run({ path: 'src/a.ts', start: 2, end: 2 }, ctx)).content).not.toContain(
      'two',
    );
    expect(
      (await readTool.run({ path: 'src/a.ts', start: 2, end: 2, refresh: true }, ctx)).content,
    ).toContain('    2  two');
    await writeFile(join(root, 'src/a.ts'), 'one\nTWO\nthree\n');
    const changed = await readTool.run({ path: 'src/a.ts' }, ctx);
    expect(changed.content).toMatch(/changed since step 1/);
    expect(changed.content).toContain('+TWO');
    expect(changed.content).not.toContain('    2  TWO');
    expect((await readTool.run({ path: 'src/a.ts', refresh: true }, ctx)).content).toContain(
      '    2  TWO',
    );
    ctx.reads?.clear();
    expect((await readTool.run({ path: 'src/a.ts' }, ctx)).content).toContain('    2  TWO');
  });

  it('sends only the delta when a large file changed at one line', async () => {
    const root = await tempDir();
    const lines = Array.from({ length: 80 }, (_, i) => `line ${String(i + 1)}`);
    await writeFile(join(root, 'big.txt'), `${lines.join('\n')}\n`);
    const ctx = await toolContext(root, { reads: new Map(), turn: 1 });
    const first = await readTool.run({ path: 'big.txt', note: 'the loop body' }, ctx);
    lines[40] = 'line 41 CHANGED';
    await writeFile(join(root, 'big.txt'), `${lines.join('\n')}\n`);
    const diff = await readTool.run({ path: 'big.txt' }, ctx);
    expect(diff.content).toMatch(/changed since step 1/);
    expect(diff.content).toContain('+line 41 CHANGED');
    expect(diff.content).not.toContain('    1  line 1');
    expect(diff.content).not.toContain('   80  line 80');
    expect(diff.savedTokens).toBeGreaterThan(200);
    expect(diff.content.length).toBeLessThan(first.content.length / 3);
  });

  it('records the tokens the guard avoided', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), `${'x'.repeat(3_000)}\n`);
    const ctx = await toolContext(root, { reads: new Map(), turn: 4 });
    await readTool.run({ path: 'a.txt' }, ctx);
    const saved = await readTool.run({ path: 'a.txt' }, ctx);
    expect(saved.savedTokens).toBeGreaterThan(500);
    const events = await import('../../../src/core/events.js').then((m) =>
      m.readEvents(ctx.events.path),
    );
    const dedupe = events.find((e) => e.type === 'read.dedup');
    expect(dedupe?.savedTokens).toBe(saved.savedTokens);
    expect(dedupe?.fromStep).toBe(4);
  });

  it('returns the bytes when the guard is disabled for a controlled A/B run', async () => {
    vi.stubEnv('OMNEXX_READ_GUARD', 'off');
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), 'x\n');
    const ctx = await toolContext(root, { reads: new Map(), turn: 1 });
    await readTool.run({ path: 'a.txt' }, ctx);
    const again = await readTool.run({ path: 'a.txt' }, ctx);
    expect(again.content).toContain('    1  x');
    expect(again.savedTokens).toBeUndefined();
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
