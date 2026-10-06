import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bm25 } from '../../../src/agent/recall.js';
import { ensureFacts } from '../../../src/agent/compaction.js';
import { recallTool } from '../../../src/tools/recall.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

describe('recall', () => {
  it('ranks by BM25 and ignores non-matching docs', () => {
    const docs = [
      { source: 'a', text: 'installed dependencies with npm ci' },
      {
        source: 'b',
        text: 'ECONNREFUSED connecting to postgres on port 5432, postgres not running',
      },
      { source: 'c', text: 'fixed the postgres pool size' },
    ];
    expect(bm25(docs, 'postgres ECONNREFUSED', 5).map((r) => r.doc.source)).toEqual(['b', 'c']);
    expect(bm25(docs, 'kubernetes', 5)).toEqual([]);
    expect(bm25(docs, '!', 5)).toEqual([]);
  });

  it('searches every progress entry, evidence and logs, not just the tail', async () => {
    const ctx = await toolContext(await tempDir());
    await writeFile(
      ctx.store.file('progress.md'),
      '## Cycle 1\nset up vite\n## Cycle 2\nhero image 404 because public/ path was wrong\n## Cycle 3\nadded footer\n',
    );
    await mkdir(ctx.store.logsDir, { recursive: true });
    await writeFile(join(ctx.store.logsDir, 'cmd-2-1.log'), 'GET /monkey.png 404 Not Found\n');
    const r = await recallTool.run({ query: '404 image' }, ctx);
    expect(r.content).toContain('## progress.md Cycle 2');
    expect(r.content).toContain('logs/cmd-2-1.log');
    expect(r.content).not.toContain('Cycle 3');
    expect((await recallTool.run({ query: 'zebra' }, ctx)).content).toMatch(/nothing/);
  });
});

describe('ensureFacts', () => {
  it('adds edited files and the last error the summary dropped', () => {
    const s = ensureFacts(
      { done: [], inProgress: 'x', filesTouched: ['a.ts'], nextStep: 'y' },
      [
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: '1', content: 'old', isError: true }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: '2', content: 'TS2322 in b.ts', isError: true },
          ],
        },
      ],
      ['b.ts', 'a.ts'],
    );
    expect(s.filesTouched).toEqual(['a.ts', 'b.ts']);
    expect(s.lastError).toBe('TS2322 in b.ts');
    const kept = ensureFacts(
      { done: [], inProgress: '', filesTouched: [], nextStep: '', lastError: 'mine' },
      [],
      [],
    );
    expect(kept.lastError).toBe('mine');
  });
});
