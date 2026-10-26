import { describe, expect, it } from 'vitest';
import { lineTag, locateRange, rangeHash } from '../../../src/tools/anchors.js';
import type { Located } from '../../../src/tools/anchors.js';

function assertOk(
  result: Located,
  expectedStart: number,
  expectedEnd: number,
  expectedMoved: boolean,
): asserts result is { ok: true; start: number; end: number; moved: boolean } {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.start).toBe(expectedStart);
    expect(result.end).toBe(expectedEnd);
    expect(result.moved).toBe(expectedMoved);
  }
}

function assertFail(
  result: Located,
  reasonContains: string,
): asserts result is { ok: false; reason: string } {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain(reasonContains);
  }
}

describe('anchors short hash (2-char) behavior', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const line10tag = lineTag(lines[9] ?? ''); // line 10 (0-indexed: 9)

  it('2-char hash on single-line range (10-10) works - doubles the tag', () => {
    const result = locateRange(lines, 10, 10, line10tag);
    assertOk(result, 10, 10, false);
  });

  it('2-char hash on multi-line range (10-20) matches start line only - returns ok:true', () => {
    // This is the bug trigger: 30-line file, lines 10-20 unchanged,
    // expected_hash = line 10's 2-char tag
    // Before fix: returns 'anchor mismatch: lines 10-20 now hash ..., not hkhk' (doubled)
    // After fix: should return {ok: true} because start line tag matches
    const result = locateRange(lines, 10, 20, line10tag);
    assertOk(result, 10, 20, false);
  });

  it('4-char hash on multi-line range (10-20) works as before - start+end tags', () => {
    const fullHash = rangeHash(lines, 10, 20); // line10tag + line20tag
    const result = locateRange(lines, 10, 20, fullHash);
    assertOk(result, 10, 20, false);
  });

  it('2-char hash on multi-line range with wrong start line fails with clear error', () => {
    // Use line 11's tag for a range starting at line 10
    const wrongTag = lineTag(lines[10] ?? ''); // line 11
    const result = locateRange(lines, 10, 20, wrongTag);
    assertFail(result, 'start line');
    expect(result.reason).not.toContain(`${wrongTag}${wrongTag}`);
  });

  it('2-char hash on multi-line range where start line moved - fails (no multi-line fuzzy recovery for 2-char)', () => {
    // Insert 5 lines at the beginning, so line 10 becomes line 15
    const shiftedLines = ['new1', 'new2', 'new3', 'new4', 'new5', ...lines];
    // The original line 10 ("line 10") is now at line 15, but we're still asking for range 10-20
    const result = locateRange(shiftedLines, 10, 20, line10tag);
    assertFail(result, 'start line tag');
  });

  it('2-char hash on single-line range where line moved within window - finds new location', () => {
    // Insert 5 lines at the beginning, so line 10 becomes line 15
    const shiftedLines = ['new1', 'new2', 'new3', 'new4', 'new5', ...lines];
    // Original line 10 is now at line 15, within fuzzy radius (15)
    const result = locateRange(shiftedLines, 10, 10, line10tag);
    assertOk(result, 15, 15, true);
  });
});
