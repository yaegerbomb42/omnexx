import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { supervise } from '../../src/core/supervisor.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { makeRepo, startTestRun } from '../support/harness.js';
import { planner, scenario } from '../support/scenarios.js';
import {
  asks,
  call,
  reviewAnswer,
  ScriptedProvider,
  say,
  type Script,
} from '../support/scripted-provider.js';

/** A chapter task: its file must exist with at least `words` words and no placeholders. */
const chapter = (id: string, file: string, words: number) => ({
  id,
  title: `Write ${file}`,
  kind: 'writing' as const,
  checks: [
    `test -f ${file} && test "$(wc -w < ${file})" -ge ${String(words)} && ! grep -qiE 'TODO|TBD' ${file}`,
  ],
});

const FILES: Record<string, string> = {
  'M1.T01': 'book/outline.md',
  'M2.T01': 'book/01-arrival.md',
  'M2.T02': 'book/02-the-map.md',
};

const prose = (n: number) =>
  Array.from({ length: n }, (_, i) => `The keeper climbed stair ${String(i)} of the tower.`).join(
    ' ',
  );

/** The author writes each task's file in full on its first turn. */
const author: Script = (m) => {
  const file = FILES[m.taskId ?? ''];
  if (!file) return say('nothing to do');
  return m.turn === 0
    ? call('write_file', { path: file, content: `# ${file}\n\n${prose(60)}\n` })
    : say(`Wrote ${file}.`);
};

describe('writing runs: a book with no tests', () => {
  it('plans an outline then chapters, keeps going past one cycle, and reviews as an editor', async () => {
    const scripted = new ScriptedProvider(
      scenario(
        planner([
          {
            id: 'M1',
            title: 'Outline and bible',
            tasks: [chapter('M1.T01', FILES['M1.T01'] ?? '', 100)],
          },
          {
            id: 'M2',
            title: 'Part one',
            tasks: [
              chapter('M2.T01', FILES['M2.T01'] ?? '', 300),
              chapter('M2.T02', FILES['M2.T02'] ?? '', 300),
            ],
          },
        ]),
        author,
      ),
    );
    const reviewSystems: string[] = [];
    const provider: Provider = {
      name: 'anthropic',
      complete(req: CompletionRequest): Promise<CompletionResponse> {
        const sys = [
          ...req.system.map((b) => b.text),
          ...(req.messages.at(-1)?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')),
        ].join('\n');
        if (!asks(req, 'reviewing one piece') && !asks(req, 'reviewing a change'))
          return scripted.complete(req);
        reviewSystems.push(sys);
        return Promise.resolve({
          content: reviewAnswer(req, { findings: [] }),
          stopReason: 'tool_use',
          usage: emptyUsage(),
          model: req.model,
        });
      },
    };
    const t = await startTestRun({
      repo: await makeRepo(),
      provider,
      goal: 'Write me a short book about a lighthouse keeper who finds a map.',
      config: {
        gates: [],
        plan: { mode: 'auto' },
        review: { enabled: true, audit: false, strict_checks: true },
      },
    });
    const out = await supervise(t.run.deps, t.run.state.runId, {
      bootId: 'b',
      heartbeatMs: 50,
      controlPollMs: 20,
      pausePollMs: 10,
    });
    expect(out.status).toBe('finished');
    const events = await readEvents(t.run.store.eventsPath);
    expect(events.filter((e) => e.type === 'run.kind').map((e) => e.kind)).toEqual(['writing']);
    // Always planned (no fast path), with the writing guidance.
    expect(events.filter((e) => e.type === 'plan.written').map((e) => e.mode)).toEqual(['initial']);
    const firstPlan = scripted.requests.find((q) =>
      q.system.some((b) => b.text.includes('You are the planner')),
    );
    expect(JSON.stringify(firstPlan?.messages)).toContain('This is a writing run');
    expect((await t.run.store.readState()).acceptedCommits).toBe(3);
    expect(reviewSystems).toHaveLength(3);
    expect(reviewSystems.every((s) => s.includes('exacting editor'))).toBe(true);
    const ch1 = await readFile(join(t.run.worktree, 'book/01-arrival.md'), 'utf8');
    expect(ch1.split(/\s+/).length).toBeGreaterThan(300);
    // The worker sees its task as an author's.
    const firstWork = scripted.requests.find((q) =>
      JSON.stringify(q.messages[0]).includes('Work on M2.T01'),
    );
    expect(JSON.stringify(firstWork?.messages[0])).toContain('Role: Author');
  });
});
