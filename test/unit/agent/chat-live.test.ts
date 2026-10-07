import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../../../src/providers/openai-compat.js';
import { describeCommand, narrateTool } from '../../../src/telemetry/narrate.js';
import { todoTool } from '../../../src/tools/todo.js';
import { toolContext } from '../../support/tool-context.js';
import { tempDir } from '../../support/tmp.js';
import { readEvents } from '../../../src/core/events.js';

describe('action lines', () => {
  it('says what the agent is doing in plain words', () => {
    expect(narrateTool('bash', { command: 'npm test' })).toBe('running test suite');
    expect(narrateTool('bash', { command: 'npx eslint .' })).toBe('checking codebase for errors');
    expect(narrateTool('bash', { command: 'npx tsc --noEmit' })).toBe('checking types');
    expect(narrateTool('write_file', { path: 'test.py' })).toBe('writing code to test.py');
    expect(narrateTool('read', { path: 'shot.png' })).toBe('analyzing image shot.png');
    expect(narrateTool('browser', { action: 'open', url: 'https://www.alexa.com/x' })).toBe(
      'browsing alexa.com',
    );
    expect(narrateTool('browser', { action: 'click', ref: '@e3' })).toBe('clicking on @e3');
    expect(narrateTool('web_search', { query: 'vitest coverage' })).toBe(
      'searching the web for vitest coverage',
    );
    expect(describeCommand('python scripts/make_report.py')).toBe(
      'running `python scripts/make_report.py`',
    );
  });
});

describe('todo tool', () => {
  it('accepts the shapes models send and publishes the list', async () => {
    const ctx = await toolContext(await tempDir());
    const input = todoTool.schema.parse(
      todoTool.normalize?.({
        items: [
          'plan',
          { content: 'write parser', status: 'in-progress' },
          { text: 'tests', done: true },
        ],
      }),
    );
    expect(input.items.map((i) => i.status)).toEqual(['pending', 'in_progress', 'done']);
    expect((await todoTool.run(input, ctx)).content).toMatch(/1\/3 done/);
    const ev = (await readEvents(ctx.events.path)).find((e) => e.type === 'todo.update');
    expect(ev?.items).toHaveLength(3);
  });
});

describe('streaming', () => {
  it('assembles an SSE stream, calling onDelta as text and reasoning arrive', async () => {
    const sse =
      [
        { choices: [{ delta: { reasoning: 'look at ' } }] },
        { choices: [{ delta: { reasoning: 'the file' } }] },
        { choices: [{ delta: { content: 'Reading ' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"pa' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
        { usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] },
      ]
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + 'data: [DONE]\n\n';
    let body = '';
    const fetchFn: typeof fetch = (_url, init) => {
      body = typeof init?.body === 'string' ? init.body : '';
      return Promise.resolve(new Response(sse, { status: 200 }));
    };
    const p = new OpenAICompatProvider({
      name: 'x',
      baseUrl: 'http://x/v1',
      apiKey: undefined,
      timeoutMs: 5_000,
      fetch: fetchFn,
    });
    const deltas: string[] = [];
    const res = await p.complete({
      model: 'm',
      system: [{ text: 's' }],
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 100,
      messageBreakpoints: [],
      onDelta: (d) => deltas.push(d.text ?? `[r]${d.reasoning ?? ''}`),
    });
    expect(JSON.parse(body)).toMatchObject({ stream: true });
    expect(deltas).toEqual(['[r]look at ', '[r]the file', 'Reading ']);
    expect(res.reasoning).toBe('look at the file');
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'text', text: 'Reading ' },
      { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } },
    ]);
    expect(res.usage.output).toBe(5);
  });
});
