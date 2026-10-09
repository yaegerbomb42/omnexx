import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../../src/cli/io.js';
import { App } from '../../../src/tui/app.js';
import { parseDiff } from '../../../src/tui/diff.js';
import { Session } from '../../../src/tui/session.js';
import { makeRepo } from '../../support/harness.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describe('diff viewer', () => {
  it('parses files and counts', () => {
    const files = parseDiff(
      [
        'diff --git a/a.js b/a.js',
        'index 1..2 100644',
        '--- a/a.js',
        '+++ b/a.js',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/b.js b/b.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/b.js',
        '@@ -0,0 +1,2 @@',
        '+x',
        '+y',
        '',
      ].join('\n'),
    );
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ['a.js', 1, 1],
      ['b.js', 2, 0],
    ]);
    expect(files[0]?.lines).toEqual(['@@ -1 +1 @@', '-old', '+new']);
  });

  it('/diff browses uncommitted changes: move, expand, close', async () => {
    const repo = await makeRepo({ 'a.js': 'one\n', 'b.js': 'two\n' });
    await writeFile(join(repo, 'a.js'), 'ONE\n');
    await writeFile(join(repo, 'b.js'), 'TWO\n');
    const s = new Session({ env: {}, cwd: repo, isTTY: false } as unknown as CliIO, () =>
      Promise.resolve(0),
    );
    const { lastFrame, stdin, unmount } = render(
      <App session={s} version="1" cwd={repo} showWhy={false} pollMs={10_000} />,
    );
    await s.submit('/diff');
    await tick();
    expect(lastFrame()).toContain('uncommitted changes · 2 files');
    expect(lastFrame()).not.toContain('+TWO');
    stdin.write('\u001B[B');
    await tick();
    stdin.write('\r');
    await tick();
    expect(lastFrame()).toContain('+TWO');
    expect(lastFrame()).not.toContain('+ONE');
    stdin.write('q');
    await tick();
    expect(s.diffView).toBeUndefined();
    unmount();
  });
});
