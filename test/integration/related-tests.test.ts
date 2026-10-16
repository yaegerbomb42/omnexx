import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import type { CompletionRequest } from '../../src/providers/types.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { planner, scenario } from '../support/scenarios.js';
import { say, ScriptedProvider, type Script } from '../support/scripted-provider.js';

const run = promisify(execFile);

/** Stands in for vitest: `related` runs the test files it is given, a plain run runs them all. */
const FAKE_VITEST = `#!/bin/sh
files=""
if [ "$1" = related ]; then
  for a in "$@"; do
    case "$a" in
      *.test.js) files="$files $a" ;;
    esac
  done
else
  files=$(ls test/*.test.js)
fi
[ -z "$files" ] && { echo 'TAP version 13'; echo '1..0'; exit 0; }
exec node --test --test-reporter=tap $files
`;

/** Unrelated to src/x.js by import, so only a full run notices it. */
const FLAG_TEST = `import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
test('flag', () => {
  if (existsSync('src/x.js')) assert.notEqual(readFileSync('src/x.js', 'utf8'), 'bad\\n');
});
`;
const xTest = (ok: boolean) =>
  `import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => assert.equal(1, ${ok ? 1 : 2}));\n`;

function lastHarnessText(req: CompletionRequest): string {
  const last = req.messages.at(-1);
  if (last?.role !== 'user' || last.content.some((b) => b.type === 'tool_result')) return '';
  return last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
}

let fixes = 0;
const worker: Script = (m) => {
  const said = lastHarnessText(m.request);
  if (said.includes('# Think first')) return say('ANALYSIS: add src/x.js with its test');
  if (said.includes('Now carry out your analysis'))
    return {
      tools: [
        { name: 'write_file', input: { path: 'src/x.js', content: 'bad\n' } },
        { name: 'write_file', input: { path: 'test/x.test.js', content: xTest(false) } },
      ],
    };
  if (said.includes('checks fail')) {
    fixes++;
    return fixes === 1
      ? { tools: [{ name: 'write_file', input: { path: 'test/x.test.js', content: xTest(true) } }] }
      : { tools: [{ name: 'write_file', input: { path: 'src/x.js', content: 'good\n' } }] };
  }
  return say('done');
};

describe('loop checks on related tests', () => {
  it('settles red rounds on related tests and only calls a round green on the full suite', async () => {
    const repo = await makeRepo({ 'bin/vitest': FAKE_VITEST, 'test/flag.test.js': FLAG_TEST });
    await chmod(join(repo, 'bin/vitest'), 0o755);
    await run('git', ['commit', '-qam', 'exec bit'], { cwd: repo });
    const t = await startTestRun({
      repo,
      provider: new ScriptedProvider(scenario(planner([]), worker)),
      config: {
        gates: [{ name: 'test', run: 'bin/vitest run', parser: 'node-test', timeout: '2m' }],
        plan: { mode: 'fast' },
        review: { enabled: false, audit: false, strict_checks: false },
      },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, {
      bootId: 'b',
      heartbeatMs: 50,
      controlPollMs: 20,
      pausePollMs: 10,
    });
    const events = await readEvents(t.run.store.eventsPath);
    expect(out.status).toBe('finished');
    expect(events.filter((e) => e.type === 'loop.check').map((e) => e.pass)).toEqual([
      false,
      false,
      true,
    ]);
    // Round 1: the related test failed, so the suite never ran. Round 2: the related test passed
    // but the full suite caught the unrelated one. Round 3: green on the full suite.
    expect(events.filter((e) => e.type === 'loop.gates').map((e) => e.settled)).toEqual([
      'related',
      'full',
      'full',
    ]);
    expect((await t.run.store.readState()).acceptedCommits).toBe(1);
  });
});
