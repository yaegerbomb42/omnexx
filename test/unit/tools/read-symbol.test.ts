import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/tokens.js';
import { outlineTool } from '../../../src/tools/outline.js';
import { readTool } from '../../../src/tools/read.js';
import {
  lookupSymbol,
  MAX_CHARS,
  readSymbolTool,
  renderFound,
} from '../../../src/tools/read-symbol.js';
import { searchTool } from '../../../src/tools/search.js';
import { readSymbolHeuristic } from '../../../src/tools/symbol-heuristic.js';
import { disposeTsWorkers } from '../../../src/tools/ts-worker.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

afterAll(disposeTsWorkers);

const TS_FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { strict: true, target: 'es2022', module: 'nodenext', noEmit: true },
    include: ['src'],
  }),
  'src/types.ts': [
    'export interface Order {',
    '  id: string;',
    '  items: Item[];',
    '}',
    '',
    'export interface Item {',
    '  sku: string;',
    '  qty: number;',
    '}',
    '',
    'export type Total = { cents: number };',
    '',
  ].join('\n'),
  'src/price.ts': [
    "import type { Item, Order, Total } from './types.js';",
    '',
    'export function lineCents(item: Item): number {',
    '  return item.qty * 100;',
    '}',
    '',
    'export function orderTotal(order: Order): Total {',
    '  let cents = 0;',
    '  for (const item of order.items) cents += lineCents(item);',
    '  return { cents };',
    '}',
    '',
  ].join('\n'),
  'src/checkout.ts': [
    "import { orderTotal } from './price.js';",
    "import type { Order } from './types.js';",
    '',
    'export function checkout(order: Order): string {',
    '  const t = orderTotal(order);',
    '  return `paid ${String(t.cents)}`;',
    '}',
    '',
    'export function preview(order: Order): number {',
    '  return orderTotal(order).cents;',
    '}',
    '',
  ].join('\n'),
  'src/dup-a.ts': 'export function helper(): number {\n  return 1;\n}\n',
  'src/dup-b.ts': 'export function helper(): number {\n  return 2;\n}\n',
};

const PY_FILES: Record<string, string> = {
  'app/models.py': [
    'class Order:',
    '    def __init__(self, items):',
    '        self.items = items',
    '',
  ].join('\n'),
  'app/price.py': [
    'from app.models import Order',
    '',
    'def line_cents(qty):',
    '    return qty * 100',
    '',
    'def order_total(order: Order) -> int:',
    '    total = 0',
    '    for qty in order.items:',
    '        total += line_cents(qty)',
    '    return total',
    '',
    'def checkout(order):',
    '    return order_total(order)',
    '',
  ].join('\n'),
};

async function repo(files: Record<string, string>, withTs = false) {
  const root = await tempDir();
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(root, p, '..'), { recursive: true });
    await writeFile(join(root, p), text);
  }
  if (withTs) {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(resolve('node_modules/typescript'), join(root, 'node_modules/typescript'));
  }
  return { root, ctx: await toolContext(root) };
}

describe('read_symbol with the TypeScript language service', () => {
  it('returns the definition, signature types across files, callers and callees', async () => {
    const { ctx } = await repo(TS_FILES, true);
    const r = await readSymbolTool.run({ symbol: 'orderTotal', depth: 1 }, ctx);
    expect(r.isError).toBeFalsy();
    const out = r.content;
    expect(out).toContain('src/price.ts:7-11');
    expect(out).toContain('    9   for (const item of order.items) cents += lineCents(item);');
    // Types from the signature, resolved in another file.
    expect(out).toContain('src/types.ts:1-4');
    expect(out).toContain('src/types.ts:11-11');
    // Callers are the enclosing functions; imports are not callers.
    expect(out).toContain('Callers (2):');
    expect(out).toContain('src/checkout.ts:4  export function checkout(order: Order): string {');
    expect(out).toContain('src/checkout.ts:9  export function preview(order: Order): number {');
    expect(out).not.toContain('src/checkout.ts:1 ');
    expect(out).toContain('Callees (1):');
    expect(out).toContain('src/price.ts:3  export function lineCents(item: Item): number {');
    expect((await lookupSymbol(ctx, { symbol: 'orderTotal', depth: 0 })).kind).toBe('found');
    const viaTs = await lookupSymbol(ctx, { symbol: 'lineCents', depth: 0 });
    expect(viaTs.kind === 'found' && viaTs.engine).toBe('typescript');
  }, 30_000);

  it('lists candidates for an ambiguous name and resolves it with path', async () => {
    const { ctx } = await repo(TS_FILES, true);
    const amb = await readSymbolTool.run({ symbol: 'helper' }, ctx);
    expect(amb.content).toMatch(/^2 definitions named helper/);
    expect(amb.content).toContain('src/dup-a.ts:1');
    expect(amb.content).toContain('src/dup-b.ts:1');
    const one = await readSymbolTool.run({ symbol: 'helper', path: 'src/dup-b.ts' }, ctx);
    expect(one.content).toContain('return 2;');
    expect(one.content).not.toContain('return 1;');
  }, 30_000);

  it('suggests close names for a missing symbol', async () => {
    const { ctx } = await repo(TS_FILES, true);
    const r = await readSymbolTool.run({ symbol: 'ordrTotal' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no definition of ordrTotal\. Close names: .*orderTotal/);
  }, 30_000);

  it('costs fewer tokens than the search + outline + read sequence it replaces', async () => {
    const { ctx } = await repo(TS_FILES, true);
    const one = (await readSymbolTool.run({ symbol: 'orderTotal', depth: 1 }, ctx)).content;
    // The usual turns: find the definition, outline it, read it, find the types, read them,
    // find the callers. Each tool call also costs a round trip of the whole context.
    const steps = [
      await searchTool.run({ pattern: 'function orderTotal' }, ctx),
      await outlineTool.run({ path: 'src/price.ts' }, ctx),
      await readTool.run({ path: 'src/price.ts' }, ctx),
      await searchTool.run({ pattern: 'interface Order|type Total' }, ctx),
      await readTool.run({ path: 'src/types.ts' }, ctx),
      await searchTool.run({ pattern: 'orderTotal\\(' }, ctx),
    ];
    const multi = steps.map((s) => s.content).join('\n');
    // Measured: 205 tokens in one call vs 468 over six calls.
    expect(estimateTokens(one) * 2).toBeLessThan(estimateTokens(multi));
  }, 30_000);
});

describe('read_symbol heuristic fallback', () => {
  it('reads a Python function with its annotated type, callers and callees', async () => {
    const { ctx } = await repo(PY_FILES);
    const r = await readSymbolTool.run({ symbol: 'order_total', depth: 1 }, ctx);
    const out = r.content;
    expect(out).toContain('app/price.py:6-10');
    expect(out).toContain('   10     return total');
    expect(out).toContain('app/models.py:1-3');
    expect(out).toContain('Callers (1):');
    expect(out).toContain('app/price.py:12  def checkout(order):');
    expect(out).toContain('Callees (1):');
    expect(out).toContain('app/price.py:3  def line_cents(qty):');
  });

  it('works for TS without a typescript install, and lists ambiguous names', async () => {
    const { root } = await repo(TS_FILES);
    const r = await readSymbolHeuristic(root, { symbol: 'orderTotal', depth: 1 });
    expect(r.kind).toBe('found');
    if (r.kind !== 'found') return;
    expect(r.engine).toBe('heuristic');
    expect([r.def.start, r.def.end]).toEqual([7, 11]);
    expect(r.types.map((t) => `${t.file}:${String(t.start)}`)).toEqual([
      'src/types.ts:1',
      'src/types.ts:11',
    ]);
    expect(r.callers.map((c) => c.line)).toEqual([4, 9]);
    const amb = await readSymbolHeuristic(root, { symbol: 'helper', depth: 0 });
    expect(amb.kind).toBe('ambiguous');
  });

  it('suggests close names when nothing matches', async () => {
    const { root } = await repo(PY_FILES);
    const r = await readSymbolHeuristic(root, { symbol: 'order_totl', depth: 0 });
    expect(r).toEqual({ kind: 'missing', suggestions: ['order_total'] });
  });

  it('rejects a path outside the repo', async () => {
    const { ctx } = await repo(PY_FILES);
    const r = await readSymbolTool.run({ symbol: 'checkout', path: '../elsewhere' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('read_symbol output cap', () => {
  it('trims a huge definition to the budget and says how to read the rest', () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `  const v${String(i)} = ${String(i)};`);
    const out = renderFound(
      {
        kind: 'found',
        engine: 'heuristic',
        def: { file: 'src/big.ts', start: 1, end: 2_000, lines },
        types: [],
        callers: [],
        callees: [],
        callerTotal: 0,
        calleeTotal: 0,
      },
      1,
    );
    expect(out.length).toBeLessThanOrEqual(MAX_CHARS + 100);
    expect(out).toMatch(/… lines \d+-2000 not shown \(read src\/big\.ts start \d+\)/);
    expect(out).toContain('output capped');
    expect(out).toContain('Callers: none found');
  });
});
