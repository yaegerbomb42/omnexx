import { describe, expect, it } from 'vitest';
import { classifyMarkdown, inlineSpans } from '../../../src/tui/markdown.js';

describe('markdown in chat replies', () => {
  it('tracks code blocks across lines and classifies the rest', () => {
    const lines = ['## Fix', 'Changed `add`:', '```js', '- a - b', '```', '- **one**', '1. two'];
    expect(classifyMarkdown(lines)).toEqual([
      'heading',
      'text',
      'fence',
      'code',
      'fence',
      'bullet',
      'bullet',
    ]);
  });

  it('splits inline code and bold, and leaves unclosed markers alone', () => {
    expect(inlineSpans('use `npm test` **now**')).toEqual([
      { text: 'use ' },
      { text: 'npm test', style: 'code' },
      { text: ' ' },
      { text: 'now', style: 'bold' },
    ]);
    expect(inlineSpans('a `b')).toEqual([{ text: 'a `b' }]);
  });
});
