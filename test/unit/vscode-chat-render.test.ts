import { describe, expect, it } from 'vitest';
import {
  addEntries,
  estimateHtml,
  etaText,
  cacheHitPercent,
  cleanQuestion,
  contextPercent,
  escapeHtml,
  formatClock,
  formatTokens,
  logRole,
  formatUsd,
  looksLikePath,
  renderMarkdown,
  stepLabel,
  stepStates,
  stepsPercent,
  toolKind,
  toolLineHtml,
  type TodoItem,
  type Usage,
} from '../../vscode/src/webview/render.js';

describe('addEntries', () => {
  it('joins consecutive lines of a message and keeps actions one per block', () => {
    const blocks = addEntries(
      [],
      [
        { id: 1, kind: 'user', text: 'fix it' },
        { id: 2, kind: 'act', text: 'read src/a.ts' },
        { id: 3, kind: 'act', text: 'edit src/a.ts' },
        { id: 4, kind: 'out', text: 'Done:' },
        { id: 5, kind: 'out', text: '- one' },
      ],
    );
    expect(blocks.map((b) => [b.id, b.kind, b.lines.length])).toEqual([
      [1, 'user', 1],
      [2, 'act', 1],
      [3, 'act', 1],
      [4, 'out', 2],
    ]);
  });

  it('continues the last block across batches without mutating the input', () => {
    const first = addEntries([], [{ id: 1, kind: 'out', text: 'a' }]);
    const second = addEntries(first, [{ id: 2, kind: 'out', text: 'b' }]);
    expect(first[0]?.lines).toEqual(['a']);
    expect(second).toEqual([{ id: 1, kind: 'out', lines: ['a', 'b'] }]);
  });
});

describe('renderMarkdown', () => {
  it('escapes HTML everywhere, including inside code and links', () => {
    const html = renderMarkdown(
      '<img src=x onerror=alert(1)> `<b>` [x](https://a.b/"onmouseover=1)',
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/href="[^"]*"onmouseover/);
  });

  it('only links http(s) URLs', () => {
    expect(renderMarkdown('[a](javascript:alert(1))')).not.toContain('<a ');
    expect(renderMarkdown('[docs](https://omnexx.org)')).toContain(
      '<a href="https://omnexx.org">docs</a>',
    );
  });

  it('renders fences, headings, lists, quotes, bold and italic', () => {
    const html = renderMarkdown(
      [
        '## Plan',
        '1. read **a**',
        '2. edit *b*',
        '',
        '```ts',
        'const x = 1 < 2;',
        '```',
        '> note',
        'plain',
        'text',
      ].join('\n'),
    );
    expect(html).toContain('<h4>Plan</h4>');
    expect(html).toContain('<ol><li>read <strong>a</strong></li><li>edit <em>b</em></li></ol>');
    expect(html).toContain('<pre data-lang="ts"><code>const x = 1 &lt; 2;</code></pre>');
    expect(html).toContain('<blockquote>note</blockquote>');
    expect(html).toContain('<p>plain text</p>');
  });

  it('makes file paths in code spans clickable', () => {
    expect(renderMarkdown('see `src/app.ts:12`')).toContain('data-open="src/app.ts:12"');
    expect(renderMarkdown('run `npm test`')).not.toContain('data-open');
  });

  it('handles an unclosed fence', () => {
    expect(renderMarkdown('```\nhalf')).toBe('<pre><code>half</code></pre>');
  });
});

describe('looksLikePath', () => {
  it('accepts file paths and rejects commands, versions and URLs', () => {
    for (const p of ['src/a.ts', './x.js', 'README.md', 'a/b/c.test.tsx:40'])
      expect(looksLikePath(p)).toBe(true);
    for (const p of ['npm test', '1.2.3', 'https://x.io/a.js', 'src/'])
      expect(looksLikePath(p)).toBe(false);
  });
});

describe('formatting', () => {
  const usage: Usage = {
    tokens: { input: 10_000, cacheRead: 8_000, cacheWrite: 0, output: 1_200 },
    usd: 0,
    turns: 3,
    toolCalls: 2,
    toolErrors: 0,
    compactions: 0,
  };

  it('formats token counts and money', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(2_000)).toBe('2k');
    expect(formatTokens(250_000)).toBe('250k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1.234)).toBe('$1.23');
  });

  it('computes cache hits and context fill', () => {
    expect(cacheHitPercent(usage)).toBe(80);
    expect(cacheHitPercent({ ...usage, tokens: { ...usage.tokens, input: 0 } })).toBe(0);
    expect(contextPercent({ used: 30_000, limit: 120_000 })).toBe(25);
    expect(contextPercent({ used: 200, limit: 100 })).toBe(100);
    expect(contextPercent(null)).toBe(0);
  });

  it('cleans questions and escapes text', () => {
    expect(cleanQuestion('run `sudo ls`? [y/N]')).toBe('run `sudo ls`?');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('timeline and log helpers', () => {
  it('formats the uptime clock and step labels', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(3_855_000)).toBe('01:04:15');
    expect(formatClock(-5)).toBe('00:00:00');
    expect(stepLabel(0)).toBe('ST-01');
    expect(stepLabel(11)).toBe('ST-12');
  });

  it('marks done, active, the step waiting on it, and queued steps', () => {
    const items: TodoItem[] = [
      { text: 'a', status: 'done' },
      { text: 'b', status: 'in_progress' },
      { text: 'c', status: 'pending' },
      { text: 'd', status: 'pending' },
    ];
    expect(stepStates(items)).toEqual(['done', 'active', 'waiting', 'queued']);
    expect(stepsPercent(items)).toBe(25);
    expect(stepsPercent([])).toBe(0);
    expect(
      stepStates([
        { text: 'a', status: 'done' },
        { text: 'b', status: 'pending' },
        { text: 'c', status: 'pending' },
      ]),
    ).toEqual(['done', 'waiting', 'queued']);
  });

  it('routes actions, thinking, notes and errors to the log, and keeps messages out', () => {
    expect(logRole('act')).toBe('agent');
    expect(logRole('think')).toBe('think');
    expect(logRole('feed')).toBe('system');
    expect(logRole('system')).toBe('system');
    expect(logRole('err')).toBe('error');
    expect(logRole('user')).toBeUndefined();
    expect(logRole('out')).toBeUndefined();
  });
});

describe('etaText', () => {
  it('counts down from the estimate, then up once it runs over', () => {
    const w = { startedAt: 1_000, estimateMs: 5_000 };
    expect(etaText(null, 0)).toBe('');
    expect(etaText(w, 1_000)).toBe('est. 5s');
    expect(etaText(w, 3_500)).toBe('est. 3s');
    expect(etaText(w, 13_000)).toBe('taking longer… 7s');
    expect(etaText({ startedAt: 0, estimateMs: null }, 12_000)).toBe('12s');
  });
});

describe('estimateHtml', () => {
  it('shows the run estimate in the countdown style, escaped, or nothing', () => {
    expect(estimateHtml(null)).toBe('');
    expect(estimateHtml(undefined)).toBe('');
    expect(estimateHtml('est. ~3 min, ~40k tokens, <$0.01')).toBe(
      '<div class="working"><span class="eta">est. ~3 min, ~40k tokens, &lt;$0.01</span></div>',
    );
  });
});

describe('toolKind', () => {
  it('sorts narrated tool lines by their leading verb', () => {
    expect(toolKind('running `npm test`')).toBe('run');
    expect(toolKind('  reading src/a.ts')).toBe('read');
    expect(toolKind('skimming the structure of src')).toBe('read');
    expect(toolKind('editing src/a.ts')).toBe('edit');
    expect(toolKind('writing code to src/b.ts')).toBe('edit');
    expect(toolKind('looking through the codebase for auth')).toBe('search');
    expect(toolKind('updating the todo list')).toBe('tool');
  });
});

describe('toolLineHtml', () => {
  it('links each path in a narrated line and escapes the rest', () => {
    expect(toolLineHtml('editing src/a.ts')).toBe(
      'editing <span class="path" data-open="src/a.ts" role="link" tabindex="0">src/a.ts</span>',
    );
    expect(toolLineHtml('running `cat <x> ./b.json`')).toBe(
      'running `cat &lt;x&gt; <span class="path" data-open="./b.json" role="link" tabindex="0">./b.json</span>`',
    );
    expect(toolLineHtml('updating the todo list')).toBe('updating the todo list');
  });
});
