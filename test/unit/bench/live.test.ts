import { describe, expect, it } from 'vitest';
import { liveName, pickTasks, QUICK_TASKS, tokensFrom } from '../../../bench/live.ts';
import { readable, tail } from '../../../bench/watch.ts';

const all = [
  'task-01-ledger-report-bug',
  'task-02-editor-undo-transactions',
  'task-03-semver-range-issue',
  'task-06-pipeline-scheduler-bugs',
  'task-10-template-engine-issue',
].map((id) => ({ id }));

describe('bench quick and live', () => {
  it('picks one task, a list, the quick sample, or all', () => {
    expect(pickTasks(all, { task: 'task-02-editor-undo-transactions' }).map((t) => t.id)).toEqual([
      'task-02-editor-undo-transactions',
    ]);
    expect(
      pickTasks(all, { tasks: 'task-01-ledger-report-bug, task-03-semver-range-issue' }),
    ).toHaveLength(2);
    expect(pickTasks(all, { quick: true }).map((t) => t.id)).toEqual([...QUICK_TASKS]);
    expect(pickTasks(all, {})).toHaveLength(5);
  });

  it('turns a meter total into fresh, cached and output tokens', () => {
    expect(
      tokensFrom({ requests: 3, prompt: 10_000, cached: 7_000, completion: 500, errors: 0 }),
    ).toEqual({ fresh: 3_000, cached: 7_000, output: 500, requests: 3 });
  });

  it('makes run tags file-safe', () => {
    expect(liveName('task-01/cline/r1')).toBe('task-01_cline_r1');
  });

  it("shows Cline's JSON events as their text and strips colors from the rest", () => {
    expect(readable('{"type":"say","say":"text","text":"Reading src/a.ts"}')).toBe(
      '[text] Reading src/a.ts',
    );
    expect(readable('{"type":"ping"}')).toBeUndefined();
    expect(readable('\x1b[32m✓ done\x1b[39m')).toBe('✓ done');
    expect(readable('   ')).toBeUndefined();
    expect(readable('DeprecationWarning: AI SDK Warning (openai-compatible.chat)')).toBeUndefined();
    expect(readable('      at iX (/$bunfs/root/chunk.js:26:46952)')).toBeUndefined();
    expect(tail(Array.from({ length: 100 }, (_, i) => `line ${String(i)}`).join('\n'), 3)).toEqual([
      'line 97',
      'line 98',
      'line 99',
    ]);
  });
});
