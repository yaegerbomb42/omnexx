import { describe, expect, it } from 'vitest';
import {
  MESSAGE_NAVIGATION_SLACK,
  nextNavigationBoundary,
  scrollOffsetToReveal,
  type NavigationRequest,
} from '../../../src/cli/message-navigation.js';

type Role = 'user' | 'assistant';

function nav(req: Omit<NavigationRequest, 'isUser' | 'length'> & { roles: Role[] }): number | null {
  const { roles, ...rest } = req;
  return nextNavigationBoundary({
    ...rest,
    length: roles.length,
    isUser: (i) => roles[i] === 'user',
  });
}

const MIXED: Role[] = ['user', 'assistant', 'user', 'assistant'];

describe('nextNavigationBoundary', () => {
  it('every-message mode treats every message as a boundary', () => {
    expect(nav({ roles: MIXED, current: 0, direction: 'down', mode: 'every-message' })).toBe(1);
    expect(nav({ roles: MIXED, current: 1, direction: 'down', mode: 'every-message' })).toBe(2);
    expect(nav({ roles: MIXED, current: 3, direction: 'up', mode: 'every-message' })).toBe(2);
    expect(nav({ roles: MIXED, current: 2, direction: 'up', mode: 'every-message' })).toBe(1);
  });

  it('every-message mode returns null past the edges', () => {
    expect(nav({ roles: MIXED, current: 0, direction: 'up', mode: 'every-message' })).toBeNull();
    expect(nav({ roles: MIXED, current: 3, direction: 'down', mode: 'every-message' })).toBeNull();
  });

  it('user-message mode only jumps to user-authored messages', () => {
    expect(nav({ roles: MIXED, current: 0, direction: 'down', mode: 'user-message' })).toBe(2);
    expect(nav({ roles: MIXED, current: 1, direction: 'down', mode: 'user-message' })).toBe(2);
    expect(nav({ roles: MIXED, current: 3, direction: 'up', mode: 'user-message' })).toBe(2);
    expect(nav({ roles: MIXED, current: 2, direction: 'up', mode: 'user-message' })).toBe(0);
  });

  it('user-message mode skips trailing assistants at the edges', () => {
    expect(nav({ roles: MIXED, current: 2, direction: 'down', mode: 'user-message' })).toBeNull();
    expect(nav({ roles: MIXED, current: 1, direction: 'up', mode: 'user-message' })).toBe(0);
  });

  it('with no user messages, user-message mode yields no boundary in either direction', () => {
    const allAssistant: Role[] = ['assistant', 'assistant'];
    expect(
      nav({ roles: allAssistant, current: 1, direction: 'down', mode: 'user-message' }),
    ).toBeNull();
    expect(
      nav({ roles: allAssistant, current: 1, direction: 'up', mode: 'user-message' }),
    ).toBeNull();
  });

  it('boundary selection ignores viewport feasibility (keeps the same boundary)', () => {
    expect(nav({ roles: MIXED, current: 0, direction: 'down', mode: 'user-message' })).toBe(2);
  });
});

describe('scrollOffsetToReveal', () => {
  // Message heights [4, 4, 4] => offsets [0, 4, 8], content height 12.
  const offsets = [0, 4, 8];
  const heights = [4, 4, 4];
  const slack = { top: 2, bottom: 2 };

  it('returns 0 when the whole transcript fits inside the viewport', () => {
    const geo = { viewportHeight: 12, scrollTop: 5, offsets, heights };
    expect(scrollOffsetToReveal(1, geo, slack)).toBe(0);
    expect(scrollOffsetToReveal(2, geo, slack)).toBe(0);
  });

  it('keeps the current offset when the message is already aligned', () => {
    // viewport 10 (max scrollable 2); message 1 occupies rows 4..8.
    const geo = { viewportHeight: 10, scrollTop: 1, offsets, heights };
    expect(scrollOffsetToReveal(1, geo, slack)).toBe(1);
    const geo2 = { viewportHeight: 10, scrollTop: 2, offsets, heights };
    expect(scrollOffsetToReveal(1, geo2, slack)).toBe(2);
  });

  it('scrolls up minimally when the message is above the viewport', () => {
    const geo = { viewportHeight: 10, scrollTop: 2, offsets, heights };
    expect(scrollOffsetToReveal(0, geo, slack)).toBe(0);
  });

  it('scrolls down minimally when the message is below the viewport', () => {
    // viewport 8 (max scrollable 4); message 1 occupies rows 4..8.
    const geo = { viewportHeight: 8, scrollTop: 0, offsets, heights };
    expect(scrollOffsetToReveal(1, geo, slack)).toBe(2);
  });

  it('clamps to the valid scroll range when slack is insufficient', () => {
    // viewport 10 (max scrollable 2); fully aligning message 2 (rows 8..12)
    // would need scrollTop >= 4, which exceeds the scrollable range. The offset
    // clamps at 2 and the selected boundary is unchanged.
    const geo = { viewportHeight: 10, scrollTop: 0, offsets, heights };
    expect(scrollOffsetToReveal(2, geo, slack)).toBe(2);
    // The boundary itself is still reported independently of scroll feasibility.
    expect(nav({ roles: MIXED, current: 0, direction: 'down', mode: 'user-message' })).toBe(2);
  });

  it('uses the default slack constant when none is provided', () => {
    // With the 12-row default slack, message 0 (top at row 0) needs scroll 0.
    const geo = { viewportHeight: 10, scrollTop: 0, offsets, heights };
    expect(scrollOffsetToReveal(0, geo)).toBe(0);
  });

  it('returns the current offset for an out-of-range index', () => {
    const geo = { viewportHeight: 10, scrollTop: 5, offsets, heights };
    expect(scrollOffsetToReveal(99, geo, slack)).toBe(5);
  });

  it('returns the current offset for an empty geometry', () => {
    const geo = { viewportHeight: 10, scrollTop: 5, offsets: [], heights: [] };
    expect(scrollOffsetToReveal(0, geo, slack)).toBe(5);
  });
});

describe('MESSAGE_NAVIGATION_SLACK', () => {
  it('exposes top and bottom padding defaults', () => {
    expect(MESSAGE_NAVIGATION_SLACK.top).toBeGreaterThan(0);
    expect(MESSAGE_NAVIGATION_SLACK.bottom).toBeGreaterThan(0);
  });
});
