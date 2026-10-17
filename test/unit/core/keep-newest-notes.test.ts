import { describe, expect, it } from 'vitest';
import { keepNewestNotes, renderNotes, type Note } from '../../../src/core/notes.js';
import { estimateTokens } from '../../../src/core/tokens.js';

const note = (n: number, text = `lesson ${String(n)} ${'x'.repeat(200)}`): Note => ({
  id: `N${String(n)}`,
  type: 'convention',
  text,
  date: '2026-10-17',
});

describe('keepNewestNotes', () => {
  const notes = [1, 2, 3, 4, 5, 6].map((n) => note(n));

  it('keeps every note that fits', () => {
    expect(keepNewestNotes(notes, 10_000)).toEqual(notes);
    expect(keepNewestNotes([], 1_000)).toEqual([]);
  });

  it('drops the oldest first and stays under the budget', () => {
    const kept = keepNewestNotes(notes, 250);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(notes.length);
    expect(kept).toEqual(notes.slice(-kept.length));
    expect(estimateTokens(renderNotes(kept))).toBeLessThanOrEqual(250);
  });

  it('always keeps the newest note, even alone over the budget', () => {
    expect(keepNewestNotes([note(1), note(2, 'y'.repeat(400))], 10)).toEqual([
      note(2, 'y'.repeat(400)),
    ]);
  });
});
