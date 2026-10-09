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
    const b = (input: Record<string, unknown>) => narrateTool('browser', input);
    expect(b({ action: 'wait_for', ref: '@e9' })).toBe('waiting for @e9 to appear');
    expect(b({ action: 'wait_for', text: 'Thanks' })).toBe('waiting for "Thanks" to appear');
    expect(b({ action: 'select', ref: '@e2', value: 'Large' })).toBe("choosing 'Large' in @e2");
    expect(b({ action: 'upload', ref: '@e4', path: 'assets/logo.png' })).toBe('uploading logo.png');
    expect(b({ action: 'switch_tab', tab: 't2' })).toBe('switching to tab t2');
    expect(b({ action: 'network' })).toBe('checking the network for failed requests');
    expect(b({ action: 'fill', ref: '@e1' })).toBe('filling in @e1');
    expect(b({ action: 'check', ref: '@e1' })).toBe('ticking @e1');
    expect(b({ action: 'uncheck', ref: '@e1' })).toBe('unticking @e1');
    expect(b({ action: 'hover', ref: '@e1' })).toBe('hovering over @e1');
    expect(b({ action: 'get_text', ref: '@e1' })).toBe('reading the text of @e1');
    expect(b({ action: 'get_url' })).toBe('checking which page the browser is on');
    expect(b({ action: 'eval' })).toBe('running a script in the page');
    expect(b({ action: 'tabs' })).toBe('listing the open tabs');
    expect(b({ action: 'new_tab', url: 'http://localhost:3000/a' })).toBe(
      'opening localhost:3000 in a new tab',
    );
    expect(b({ action: 'close_tab', tab: 't2' })).toBe('closing tab t2');
    expect(b({ action: 'close_tab' })).toBe('closing the tab');
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

describe('small input and display fixes from the live run', () => {
  it('multi_edit hoists a path repeated inside each edit', async () => {
    const { multiEditTool } = await import('../../../src/tools/edit.js');
    const parsed = multiEditTool.schema.parse(
      multiEditTool.normalize?.({
        edits: [
          { path: 'src/a.js', old_str: 'a', new_str: 'b' },
          { path: 'src/a.js', old_str: 'c', new_str: 'd' },
        ],
      }),
    );
    expect(parsed.path).toBe('src/a.js');
    expect(parsed.edits).toEqual([
      { old_str: 'a', new_str: 'b' },
      { old_str: 'c', new_str: 'd' },
    ]);
  });

  it('shows the failing line of a command, not its exit header', async () => {
    const { errorLine } = await import('../../../src/tui/code-chat.js');
    expect(errorLine('[exit 1, 164ms, log cmd-1]\n\nnot ok 1 - add\n  error: Expected 5')).toBe(
      'not ok 1 - add',
    );
    expect(errorLine('[exit 2, 5ms]\nsomething odd')).toBe('something odd');
  });
});

describe('enable_thinking negotiation', () => {
  it('resends with enable_thinking:false when asked, and without it when a thinking-only model refuses', async () => {
    const bodies: Record<string, unknown>[] = [];
    const answers = [
      {
        status: 400,
        body: {
          error: {
            message: 'parameter.enable_thinking must be set to false for non-streaming calls',
          },
        },
      },
      {
        status: 400,
        body: {
          error: { message: 'The value of the enable_thinking parameter is restricted to True.' },
        },
      },
      { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } },
    ];
    const fetchFn: typeof fetch = (_u, init) => {
      bodies.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
      );
      const a = answers.shift();
      return Promise.resolve(new Response(JSON.stringify(a?.body), { status: a?.status ?? 500 }));
    };
    const p = new OpenAICompatProvider({
      name: 'pool',
      baseUrl: 'http://x/v1',
      apiKey: undefined,
      timeoutMs: 5_000,
      fetch: fetchFn,
    });
    const res = await p.complete({
      model: 'pool-random',
      system: [{ text: 's' }],
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 10,
      messageBreakpoints: [],
    });
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(bodies.map((b) => b.enable_thinking)).toEqual([undefined, false, undefined]);
  });
});
