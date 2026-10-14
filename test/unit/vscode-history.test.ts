import { describe, expect, it } from 'vitest';
import {
  historyGroup,
  parseChats,
  relativeTime,
  runTitle,
  type RunRow,
} from '../../vscode/src/model.js';

const NOON = new Date(2026, 9, 14, 12, 0, 0).getTime();
const HOUR = 3_600_000;

describe('History in the VS Code sidebar', () => {
  it('groups by calendar day', () => {
    expect(historyGroup(NOON - HOUR, NOON)).toBe('Today');
    expect(historyGroup(NOON - 13 * HOUR, NOON)).toBe('Yesterday');
    expect(historyGroup(NOON - 40 * HOUR, NOON)).toBe('Earlier');
  });

  it('says how long ago', () => {
    expect(relativeTime(NOON - 10_000, NOON)).toBe('just now');
    expect(relativeTime(NOON - 5 * 60_000, NOON)).toBe('5m ago');
    expect(relativeTime(NOON - 3 * HOUR, NOON)).toBe('3h ago');
    expect(relativeTime(NOON - 50 * HOUR, NOON)).toBe('2d ago');
  });

  it('names runs by their goal, falling back to repo and id', () => {
    const run = { runId: 'r_1', repoName: 'arcade' } as RunRow;
    expect(runTitle(run)).toBe('arcade · r_1');
    expect(runTitle({ ...run, goal: 'fix arcade nav buttons' })).toBe('Fix arcade nav buttons');
  });

  it('parses chats --json and rejects junk', () => {
    expect(
      parseChats('[{"id":"chat_a","title":"Fix it","savedAt":5,"messages":2,"model":null}]'),
    ).toEqual([{ id: 'chat_a', title: 'Fix it', savedAt: 5, messages: 2 }]);
    expect(() => parseChats('{}')).toThrow(/list of chats/);
  });
});
