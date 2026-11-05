import { describe, expect, it } from 'vitest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextGarbageCollector } from '../../../src/runtime/kernel/contextGc.js';
import { MemoryVfs } from '../../../src/runtime/kernel/vfs.js';
import { StateCheckpointer } from '../../../src/runtime/kernel/checkpoint.js';
import {
  allocationSimilarities,
  multiSampleAllocations,
} from '../../../src/runtime/kernel/ollamaRouter.js';
import type { Message } from '../../../src/providers/types.js';
import { tempDir } from '../../support/tmp.js';

function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function toolResult(id: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: id, content }],
  };
}

describe('ContextGarbageCollector', () => {
  it('drops older near-duplicate tool results and keeps the tail', () => {
    const gc = new ContextGarbageCollector();
    const messages: Message[] = [
      msg('user', 'goal: fix tests'),
      toolResult('1', 'PASS all 10 tests green output ' + 'x'.repeat(200)),
      toolResult('2', 'PASS all 10 tests green output ' + 'x'.repeat(200)),
      msg('assistant', 'continuing'),
      toolResult('3', 'completely different failure stack'),
      msg('user', 'keep going'),
      msg('assistant', 'ok'),
      msg('user', 'recent'),
    ];
    const result = gc.compact(messages, { keepRecent: 3, similarityThreshold: 0.9 });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  it('preserves kernel/harness directives', () => {
    const gc = new ContextGarbageCollector();
    const messages: Message[] = [
      msg('user', 'goal'),
      msg('user', '[kernel] tier=1 mode=cot'),
      msg('user', '[kernel] tier=1 mode=cot'),
      msg('assistant', 'a'),
      msg('assistant', 'b'),
      msg('assistant', 'c'),
      msg('user', 'tail'),
    ];
    const result = gc.compact(messages, { keepRecent: 2, similarityThreshold: 0.5 });
    const texts = result.messages.flatMap((m) =>
      m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text),
    );
    expect(texts.filter((t) => t.startsWith('[kernel]')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('MemoryVfs + non-git checkpoint', () => {
  it('snapshots and restores without git', async () => {
    const root = await tempDir('omnexx-vfs-');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'v1\n');

    const vfs = new MemoryVfs(root);
    await vfs.ingest('src/a.ts');
    const cp = new StateCheckpointer({ worktree: root, vfs });

    await writeFile(join(root, 'src/a.ts'), 'v2\n');
    await vfs.ingest('src/a.ts');
    const snap = await cp.snapshot('n1', 2, ['src/a.ts']);
    expect(snap.usedVfs).toBe(true);
    expect(snap.files['src/a.ts']).toContain('v2');

    await writeFile(join(root, 'src/a.ts'), 'BROKEN\n');
    const rb = await cp.rollbackToCheckpoint('n1', 'bad edit');
    expect(rb.restored).toBe(true);
    expect(rb.usedVfs).toBe(true);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('v2\n');
  });
});

describe('multi-sample divergence', () => {
  it('produces pairwise similarities for telemetry', () => {
    const samples = multiSampleAllocations(
      {
        objective: 'edit and test the module',
        stateDelta: '',
        telemetry: {
          frictionScore: 2,
          contextPressure: 0.4,
          epistemicUncertainty: 0.3,
          consecutiveFailures: 1,
          lastToolSignature: '',
          turn: 3,
        },
        candidates: [
          { kind: 'tool', id: 'read', name: 'read', description: 'read', tokens: ['read'] },
          { kind: 'tool', id: 'bash', name: 'bash', description: 'bash', tokens: ['bash'] },
          {
            kind: 'tool',
            id: 'str_replace',
            name: 'str_replace',
            description: 'edit',
            tokens: ['edit'],
          },
        ],
        profile: { maxWindow: 100_000, attentionCeiling: 0.65, maxMountedTools: 5 },
      },
      [
        { kind: 'tool', id: 'read', name: 'read', description: 'read', tokens: ['read'] },
        { kind: 'tool', id: 'bash', name: 'bash', description: 'bash', tokens: ['bash'] },
        {
          kind: 'tool',
          id: 'str_replace',
          name: 'str_replace',
          description: 'edit',
          tokens: ['edit'],
        },
      ],
      3,
    );
    expect(samples).toHaveLength(3);
    const sims = allocationSimilarities(samples);
    expect(sims.length).toBe(3); // C(3,2)
    for (const s of sims) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
