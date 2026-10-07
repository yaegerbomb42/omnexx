import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { startTestRun } from '../support/harness.js';
import { call, say, ScriptedProvider, type Script } from '../support/scripted-provider.js';

const plan = {
  milestones: [
    { id: 'M1', title: 'Fix', tasks: [{ id: 'M1.T01', title: 'Make add() add', checks: [] }] },
  ],
};
const fixAdd: Script = ({ turn }) =>
  [
    call('str_replace', {
      path: 'src/math.js',
      old_str: 'return a - b;',
      new_str: 'return a + b;',
    }),
    say('Fixed add().'),
  ][turn] ?? say('done');

/** The worker script, plus a reviewer that answers with `review` (or garbage). */
function withReviewer(review: unknown): Provider & { reviews: number } {
  const worker = new ScriptedProvider(fixAdd);
  const p = {
    name: 'anthropic',
    reviews: 0,
    complete(req: CompletionRequest): Promise<CompletionResponse> {
      if (!req.system.some((b) => b.text.includes('strict senior engineer')))
        return worker.complete(req);
      p.reviews++;
      return Promise.resolve({
        content:
          review === 'garbage'
            ? [{ type: 'text', text: 'looks fine to me' }]
            : [{ type: 'tool_use', id: 'r1', name: 'answer', input: review }],
        stopReason: 'tool_use',
        usage: emptyUsage(),
        model: req.model,
      });
    },
  };
  return p;
}

async function cycleWith(review: unknown) {
  const provider = withReviewer(review);
  const t = await startTestRun({
    provider,
    plan,
    config: { review: { enabled: true, audit: false } },
  });
  await runBaseline(t.run);
  const v = await runOneCycle(t.run, 'M1.T01');
  return { v, provider, events: await readEvents(t.run.events.path), t };
}

describe('review before commit', () => {
  it('a blocking finding rejects a change the tests passed, and tells the worker why', async () => {
    const { v, provider, t } = await cycleWith({
      findings: [
        {
          severity: 'blocker',
          file: 'src/math.js',
          problem: 'add() ignores the overflow case the task requires',
          fix: 'handle it',
        },
      ],
    });
    expect(provider.reviews).toBe(1);
    expect(v.verdict).toBe('reject');
    expect(v.reasons.join()).toMatch(/review: add\(\) ignores the overflow/);
    const task = t.run.plan?.nodes.find((n) => n.id === 'M1.T01');
    expect(task?.evidence.join()).toMatch(/Rejected in review[\s\S]*\[blocker\] src\/math\.js/);
  });

  it('minor findings and a clean review let it through', async () => {
    const minor = await cycleWith({
      findings: [{ severity: 'minor', problem: 'could use a comment' }],
    });
    expect(minor.v.verdict).toBe('accept');
    expect(minor.events.find((e) => e.type === 'review.result')).toMatchObject({
      findings: 1,
      blocking: 0,
    });
    expect((await cycleWith({ findings: [] })).v.verdict).toBe('accept');
  });

  it('fails open: a reviewer that answers nonsense never blocks work', async () => {
    const { v, provider } = await cycleWith('garbage');
    expect(provider.reviews).toBe(1);
    expect(v.verdict).toBe('accept');
  });
});
