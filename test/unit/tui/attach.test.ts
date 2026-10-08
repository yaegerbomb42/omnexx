import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextTokens } from '../../../src/agent/compaction.js';
import { toChatMessages } from '../../../src/providers/openai-compat.js';
import { attachImages, imagePathsIn } from '../../../src/tui/attach.js';
import { tempDir } from '../../support/tmp.js';

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('image attachments', () => {
  it('finds plain, quoted and drag-and-drop (escaped space) paths', () => {
    expect(
      imagePathsIn(`look at shot.png and '/a b/c.JPG' and /Users/me/Screen\\ Shot\\ 1.png please`),
    ).toEqual(['shot.png', '/a b/c.JPG', '/Users/me/Screen Shot 1.png']);
    expect(imagePathsIn('a png is an image format')).toEqual([]);
  });

  it('attaches only images that exist, as base64 blocks', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'ui shot.png'), PNG);
    const r = await attachImages('what is wrong in ui\\ shot.png vs missing.png?', dir);
    expect(r.attached).toEqual(['ui shot.png']);
    expect(r.blocks).toEqual([
      { type: 'image', mediaType: 'image/png', data: PNG.toString('base64') },
    ]);
  });

  it('sends images as image_url parts and counts them at a flat cost, not by base64 length', () => {
    const big = 'A'.repeat(400_000);
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'what is this?' },
          { type: 'image' as const, mediaType: 'image/png' as const, data: big },
        ],
      },
    ];
    const chat = toChatMessages({
      model: 'm',
      system: [{ text: 's' }],
      tools: [],
      messages,
      maxTokens: 10,
      messageBreakpoints: [],
    });
    expect(chat[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } },
      ],
    });
    expect(contextTokens(messages)).toBeLessThan(2_000);
  });
});
