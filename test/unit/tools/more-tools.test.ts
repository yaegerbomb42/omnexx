import { describe, expect, it } from 'vitest';
import { DEFERRED_TOOLS } from '../../../src/tools/more-tools.js';
import { exposedTools, toolSpec, WORKER_TOOLS } from '../../../src/tools/registry.js';
import { toolContext } from '../../support/tool-context.js';
import { tempRepo } from '../../support/tmp.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const opts = { subagents: false, hasHistory: true, autoApprove: false };
const size = (tools: ReturnType<typeof exposedTools>) =>
  JSON.stringify(tools.map((t) => toolSpec(t))).length;

describe('lazy_tools: rarely called tools behind more_tools', () => {
  it('is off by default: the tool list is unchanged', () => {
    const plain = exposedTools(WORKER_TOOLS, opts);
    expect(exposedTools(WORKER_TOOLS, { ...opts, lazyTools: false })).toEqual(plain);
    expect(plain.some((t) => t.name === 'more_tools')).toBe(false);
  });

  it('swaps the deferred schemas for one smaller tool, keeping every other tool in order', () => {
    const plain = exposedTools(WORKER_TOOLS, opts);
    const lazy = exposedTools(WORKER_TOOLS, { ...opts, lazyTools: true });
    expect(lazy.at(-1)?.name).toBe('more_tools');
    expect(lazy.slice(0, -1).map((t) => t.name)).toEqual(
      plain.filter((t) => !DEFERRED_TOOLS.has(t.name)).map((t) => t.name),
    );
    expect(lazy.find((t) => t.name === 'read_log')).toBeDefined();
    expect(size(lazy)).toBeLessThan(size(plain) * 0.85);
    for (const name of DEFERRED_TOOLS) expect(lazy[lazy.length - 1]?.description).toContain(name);
  });

  it('describes a tool without input, runs it with input, and explains bad input', async () => {
    const repo = await tempRepo();
    await writeFile(
      join(repo, 'a.ts'),
      'export function sum(a: number, b: number) {\n  return a + b;\n}\n',
    );
    const ctx = await toolContext(repo);
    const more = exposedTools(WORKER_TOOLS, { ...opts, lazyTools: true }).at(-1);
    if (!more) throw new Error('more_tools missing');

    const about = await more.run({ tool: 'outline' }, ctx);
    expect(about.isError).toBeUndefined();
    expect(about.content).toMatch(/^outline: /);
    expect(about.content).toContain('Input schema:');

    const ran = await more.run({ tool: 'outline', input: { path: 'a.ts' } }, ctx);
    expect(ran.content).toContain('sum');

    const bad = await more.run({ tool: 'outline', input: { nope: 1 } }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/^invalid input for outline/);
  });
});
