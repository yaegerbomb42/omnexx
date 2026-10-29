import { describe, expect, it } from 'vitest';
import { pruneSuperseded } from '../../../src/agent/compaction.js';
import type { Message } from '../../../src/providers/types.js';

const big = (label: string) => `${label}\n${'x'.repeat(2_000)}`;
let n = 0;
/** One assistant tool call and its result. */
function step(name: string, input: unknown, content: string, isError = false): Message[] {
  const id = `t${String(++n)}`;
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content, isError }] },
  ];
}
const results = (ms: Message[]) =>
  ms.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : [])));

describe('pruneSuperseded: dead weight out, without a model', () => {
  it('stubs a read that a later read of the same lines (or the whole file) supersedes', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
      ...step('read', { path: 'src/a.ts' }, big('a v1')),
      ...step('read', { path: 'src/a.ts', start: 10, end: 20 }, big('a 10-20')),
      ...step('read', { path: 'src/b.ts' }, big('b')),
      ...step('read', { path: 'src/a.ts' }, big('a v2')),
    ];
    const r = pruneSuperseded(msgs);
    const out = results(r.messages);
    expect(out[0]).toMatch(/^\[superseded by omnexx: src\/a\.ts was read again later/);
    expect(out[1]).toMatch(/^\[superseded by omnexx: src\/a\.ts/);
    expect(out[2]).toMatch(/^b\n/);
    expect(out[3]).toMatch(/^a v2\n/);
    expect(r.pruned).toBe(2);
    expect(r.chars).toBeGreaterThan(4_000);
    // Calls stay paired with their results, and the input is not mutated.
    expect(r.messages.filter((m) => m.content[0]?.type === 'tool_use')).toHaveLength(4);
    expect(results(msgs)[0]).toMatch(/^a v1/);
  });

  it('keeps a narrower later read from superseding a wider earlier one', () => {
    const msgs = [
      ...step('read', { path: 'src/c.ts' }, big('c whole')),
      ...step('read', { path: 'src/c.ts', start: 5, end: 9 }, big('c 5-9')),
    ];
    expect(pruneSuperseded(msgs).pruned).toBe(0);
  });

  it('collapses a failed command once the same command later succeeds', () => {
    const msgs = [
      ...step('bash', { command: 'npm test' }, big('[exit 1] FAIL a.test.ts'), true),
      ...step('bash', { command: 'npm run lint' }, big('[exit 1] lint error'), true),
      ...step('bash', { command: 'npm test' }, big('[exit 0] all green')),
    ];
    const out = results(pruneSuperseded(msgs).messages);
    expect(out[0]).toMatch(/^\[superseded by omnexx: `npm test` failed here and passed later/);
    expect(out[1]).toMatch(/lint error/);
    expect(out[2]).toMatch(/all green/);
  });

  it('keeps only the newest output of a rerun command, noting how the older run ended', () => {
    const msgs = [
      ...step('bash', { command: 'npm test' }, big('[exit 0] 3 passed')),
      ...step('bash', { command: 'npm test' }, big('[exit 1] 1 failed'), true),
      ...step('bash', { command: 'npm test' }, big('[exit 1] 2 failed'), true),
      ...step('bash', { command: 'git status' }, big('clean')),
    ];
    const out = results(pruneSuperseded(msgs).messages);
    expect(out[0]).toMatch(/^\[superseded by omnexx: `npm test` passed here and ran again later/);
    expect(out[1]).toMatch(/^\[superseded by omnexx: `npm test` failed here and ran again later/);
    expect(out[2]).toMatch(/2 failed/);
    expect(out[3]).toMatch(/clean/);
  });

  it('leaves small results and already-stubbed ones alone', () => {
    const msgs = [
      ...step('read', { path: 'tiny.ts' }, 'short'),
      ...step('read', { path: 'tiny.ts' }, 'short again'),
    ];
    expect(pruneSuperseded(msgs).pruned).toBe(0);
  });

  it('stubs an identical earlier grep/glob but keeps distinct patterns or options', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
      ...step('grep', { pattern: 'foo', path: 'src' }, big('g1')),
      ...step('grep', { pattern: 'foo', path: 'src', ignoreCase: true }, big('g-i')),
      ...step('grep', { pattern: 'bar', path: 'src' }, big('g-bar')),
      ...step('grep', { pattern: 'foo', path: 'src' }, big('g2')),
    ];
    const out = results(pruneSuperseded(msgs).messages);
    expect(out[0]).toMatch(/^\[superseded by omnexx:/);
    expect(out.slice(1).map((o) => o.split('\n')[0])).toEqual(['g-i', 'g-bar', 'g2']);
  });

  it('treats whitespace-only command differences as a rerun', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
      ...step('bash', { command: 'npx  eslint src' }, big('errs'), true),
      ...step('bash', { command: 'npx eslint src ' }, big('clean')),
    ];
    const out = results(pruneSuperseded(msgs).messages);
    expect(out[0]).toMatch(/failed here and passed later/);
    expect(out[1]).toMatch(/^clean/);
  });

  it('stubs a pre-edit read only once the file is read again after the edit', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
      ...step('read', { path: 'src/d.ts' }, big('only copy')),
      ...step('edit', { path: 'src/d.ts' }, 'ok'),
      ...step('read', { path: 'src/e.ts' }, big('e before')),
      ...step('edit', { path: 'src/e.ts' }, 'ok'),
      ...step('read', { path: 'src/e.ts', start: 1, end: 5 }, big('e after')),
    ];
    const out = results(pruneSuperseded(msgs).messages);
    expect(out[0]).toMatch(/^only copy/);
    expect(out[2]).toMatch(/was edited and read again later/);
    expect(out[4]).toMatch(/^e after/);
  });
});
