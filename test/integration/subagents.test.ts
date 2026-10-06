import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
} from '../../src/providers/types.js';
import { startTestRun } from '../support/harness.js';

const onePlan = () => ({
  milestones: [{ id: 'M1', title: 'Fix', tasks: [{ id: 'M1.T01', title: 'Fix add', checks: [] }] }],
});

/**
 * The worker asks two helpers questions in one turn, then fixes add(). Helpers sleep, so we can
 * see whether they overlapped, and record the tools they were offered.
 */
class HelperProvider implements Provider {
  readonly name = 'helper';
  active = 0;
  maxActive = 0;
  helperTools: string[][] = [];
  workerResults: string[] = [];
  private ids = 0;

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const helper = req.system.some((b) => b.text.includes('read-only helper'));
    const turn = req.messages.filter((m) => m.role === 'assistant').length;
    let content: ContentBlock[];
    if (helper) {
      this.helperTools.push(req.tools.map((t) => t.name));
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise((r) => setTimeout(r, 50));
      this.active--;
      const q = req.messages[0]?.content[0];
      content = [
        {
          type: 'text',
          text: `answer to: ${q?.type === 'text' ? (q.text.split('\n\n').at(-1) ?? '') : ''}`,
        },
      ];
    } else if (turn === 0) {
      content = ['where is add defined?', 'how are tests run?'].map((description) => ({
        type: 'tool_use',
        id: `t${++this.ids}`,
        name: 'task',
        input: { description },
      }));
    } else if (turn === 1) {
      const last = req.messages.at(-1)?.content ?? [];
      this.workerResults = last.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
      content = [
        {
          type: 'tool_use',
          id: `t${++this.ids}`,
          name: 'str_replace',
          input: { path: 'src/math.js', old_str: 'return a - b;', new_str: 'return a + b;' },
        },
      ];
    } else {
      content = [{ type: 'text', text: 'fixed' }];
    }
    return {
      content,
      stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: { uncached: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 50 },
      model: req.model,
    };
  }
}

describe('W11: task subagents', () => {
  it('fan out in parallel, get only read-only tools, and hand back just their answers', async () => {
    const provider = new HelperProvider();
    const t = await startTestRun({ provider, plan: onePlan() });
    await runBaseline(t.run);
    expect(await runOneCycle(t.run, 'M1.T01')).toMatchObject({ verdict: 'accept' });

    expect(provider.maxActive).toBe(2);
    expect(provider.helperTools).toHaveLength(2);
    for (const tools of provider.helperTools) {
      expect(tools).toContain('read');
      for (const denied of ['task', 'remember', 'str_replace', 'write_file', 'bash'])
        expect(tools).not.toContain(denied);
    }
    expect(provider.workerResults).toEqual([
      expect.stringContaining('answer to: where is add defined?'),
      expect.stringContaining('answer to: how are tests run?'),
    ]);
    const events = await readEvents(t.run.events.path);
    expect(events.filter((e) => e.type === 'subagent.finish')).toHaveLength(2);
  });
});
