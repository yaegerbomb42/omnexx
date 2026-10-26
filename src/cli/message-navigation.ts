/**
 * Message navigation boundaries and viewport slack alignment.
 *
 * Navigation has two modes:
 * - "user-message": only user-authored messages are jump targets;
 * - "every-message": every message is a jump target.
 *
 * Targets are logical indices computed purely from the transcript's roles; they
 * never depend on scroll feasibility. When the viewport cannot fully reveal a
 * boundary, alignment clamps to the valid scroll range and keeps the same
 * boundary rather than skipping to a different message.
 */

export type NavigationMode = 'user-message' | 'every-message';
export type NavigationDirection = 'up' | 'down';

export interface NavigationRequest {
  /** Currently selected message index. */
  current: number;
  direction: NavigationDirection;
  mode: NavigationMode;
  /** Total number of messages in the transcript. */
  length: number;
  /** Whether the message at `index` is user-authored. */
  isUser: (index: number) => boolean;
}

/**
 * Return the next jump-target index in `direction` from `current`, or `null`
 * when there is no such boundary. In "user-message" mode only user-authored
 * messages count; in "every-message" mode every message counts. The result is
 * independent of viewport state.
 */
export function nextNavigationBoundary(req: NavigationRequest): number | null {
  const { current, direction, mode, length, isUser } = req;
  const step = direction === 'up' ? -1 : 1;
  for (let i = current + step; i >= 0 && i < length; i += step) {
    if (mode === 'every-message' || isUser(i)) return i;
  }
  return null;
}

/** Padding kept around the revealed message inside the viewport. */
export interface NavigationSlack {
  /** Rows of padding above the selected message's top edge. */
  top: number;
  /** Rows of padding below the selected message's bottom edge. */
  bottom: number;
}

/** Default slack, mirroring the design spec's `--space-5` (12px) list gutter. */
export const MESSAGE_NAVIGATION_SLACK: NavigationSlack = { top: 12, bottom: 12 };

export interface ViewportGeometry {
  /** Visible height of the viewport, in rows. */
  viewportHeight: number;
  /** Current scroll offset, in rows from the top of the transcript. */
  scrollTop: number;
  /** Top offset of each message within the full transcript, in rows. */
  offsets: readonly number[];
  /** Height of each message, in rows. */
  heights: readonly number[];
}

/**
 * Minimal scroll offset that reveals message `index` inside the viewport while
 * keeping `slack` padding above and below it. Returns the current offset when
 * it already satisfies the alignment. When the content cannot fully satisfy the
 * alignment (insufficient scroll slack), the offset is clamped to the valid
 * scroll range and the selected boundary is unchanged.
 */
export function scrollOffsetToReveal(
  index: number,
  geo: ViewportGeometry,
  slack: NavigationSlack = MESSAGE_NAVIGATION_SLACK,
): number {
  const { viewportHeight, scrollTop, offsets, heights } = geo;
  if (offsets.length === 0 || heights.length !== offsets.length) return scrollTop;

  const top = offsets[index];
  const height = heights[index];
  if (top === undefined || height === undefined) return scrollTop;

  const lastOffset = offsets[offsets.length - 1];
  const lastHeight = heights[heights.length - 1];
  if (lastOffset === undefined || lastHeight === undefined) return scrollTop;

  const contentHeight = lastOffset + lastHeight;
  if (contentHeight <= viewportHeight) return 0;

  const maxScrollable = contentHeight - viewportHeight;
  const bottom = top + height;

  // Prefer keeping the message's top edge visible: scroll up when the top is
  // closer than `slack.top` to the viewport's top edge; otherwise scroll down
  // when the bottom intrudes on the lower `slack.bottom` padding.
  let offset = scrollTop;
  if (top < scrollTop + slack.top) {
    offset = top - slack.top;
  } else if (bottom > scrollTop + viewportHeight - slack.bottom) {
    offset = bottom + slack.bottom - viewportHeight;
  }

  return Math.min(maxScrollable, Math.max(0, offset));
}
