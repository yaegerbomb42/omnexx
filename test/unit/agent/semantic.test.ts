import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkLines, SemanticIndex } from '../../../src/agent/semantic.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { git } from '../../../src/git/git.js';
import { makeRepo } from '../../support/harness.js';
import { isolatedEnv } from '../../support/tmp.js';

const TOPICS = ['payment', 'retry', 'login', 'password', 'chart', 'render'];
/** A fake /embeddings: a vector of topic-word counts, so related texts land close together. */
function fakeEmbeddings(calls: string[][]): typeof fetch {
  return (_url, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      input: string[];
    };
    calls.push(body.input);
    const data = body.input.map((t, index) => ({
      index,
      embedding: TOPICS.map((w) => (t.toLowerCase().match(new RegExp(w, 'g')) ?? []).length + 0.01),
    }));
    return Promise.resolve(new Response(JSON.stringify({ data })));
  };
}

describe('semantic search', () => {
  it('chunks with overlap', () => {
    expect(chunkLines(10, 60)).toEqual([[1, 10]]);
    expect(chunkLines(130, 60)).toEqual([
      [1, 60],
      [46, 105],
      [91, 130],
    ]);
  });

  it('finds code by meaning and only re-embeds files that changed', async () => {
    const repo = await makeRepo({
      'src/billing.js':
        'export function chargeWithBackoff() {\n  // retry the payment up to 3 times\n}\n',
      'src/auth.js':
        'export function checkPassword() {\n  // login: compare the password hash\n}\n',
      'src/plot.js': 'export function draw() {\n  // render the chart\n}\n',
    });
    const calls: string[][] = [];
    const index = await SemanticIndex.open(
      resolvePaths(await isolatedEnv()),
      repo,
      { baseUrl: 'http://emb/v1', apiKey: 'k', model: 'm', fetch: fakeEmbeddings(calls) },
      { maxFiles: 100, chunkLines: 60 },
    );
    const first = await index.refresh();
    expect(first.embedded).toBe(first.files);
    expect(first.files).toBeGreaterThanOrEqual(3);
    const hits = await index.search('where are failed payments retried', 2);
    expect(hits[0]).toMatchObject({ path: 'src/billing.js', start: 1 });
    expect(hits[0]?.text).toContain('chargeWithBackoff');

    expect(await index.refresh()).toEqual({ embedded: 0, files: first.files });
    await writeFile(
      join(repo, 'src/plot.js'),
      'export function draw() {\n  // render the chart twice\n}\n',
    );
    await git(repo, ['add', '-A']);
    expect(await index.refresh()).toEqual({ embedded: 1, files: first.files });
  });
});
