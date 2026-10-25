import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo, useState } from 'react';
import {
  nextNavigationBoundary,
  scrollOffsetToReveal,
  type NavigationMode,
} from './message-navigation.js';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  lines: string[];
}

export interface TranscriptViewProps {
  messages: TranscriptMessage[];
  /** Which messages are jump targets. Defaults to every message. */
  mode?: NavigationMode;
  /** Whether arrow keys navigate. Disabled while another surface owns input. */
  active?: boolean;
  /** Visible height used for alignment; defaults to the terminal height. */
  viewportHeight?: number;
}

/** Row gap between consecutive messages in the transcript layout. */
const GAP = 1;

function layout(messages: TranscriptMessage[]): { offsets: number[]; heights: number[] } {
  const heights: number[] = [];
  const offsets: number[] = [];
  let acc = 0;
  for (const message of messages) {
    offsets.push(acc);
    heights.push(message.lines.length);
    acc += message.lines.length + GAP;
  }
  return { offsets, heights };
}

/** Index range of messages intersecting the [scrollTop, scrollTop+viewportHeight) window. */
export function visibleSlice(
  scrollTop: number,
  viewportHeight: number,
  offsets: number[],
  heights: number[],
): { start: number; end: number } {
  let start = 0;
  while (start < offsets.length && (offsets[start] ?? 0) + (heights[start] ?? 0) <= scrollTop)
    start++;
  let end = start;
  while (end < offsets.length && (offsets[end] ?? 0) < scrollTop + viewportHeight) end++;
  return { start, end };
}

export function TranscriptView({
  messages,
  mode = 'every-message',
  active = true,
  viewportHeight: propViewportHeight,
}: TranscriptViewProps) {
  const { rows: winHeight } = useWindowSize();
  const viewportHeight = propViewportHeight ?? winHeight;

  const { offsets, heights } = useMemo(() => layout(messages), [messages]);
  const [selected, setSelected] = useState<number>(() => {
    if (!messages.length) return 0;
    if (mode === 'user-message') {
      const firstUser = messages.findIndex((m) => m.role === 'user');
      return firstUser === -1 ? 0 : firstUser;
    }
    return messages.length - 1;
  });
  const [scrollTop, setScrollTop] = useState(0);

  useInput(
    (_input, key) => {
      if (!key.upArrow && !key.downArrow) return;
      const direction = key.upArrow ? 'up' : 'down';
      const next = nextNavigationBoundary({
        current: selected,
        direction,
        mode,
        length: messages.length,
        isUser: (i) => messages[i]?.role === 'user',
      });
      if (next === null) return;
      setSelected(next);
      setScrollTop((prev) =>
        scrollOffsetToReveal(next, { viewportHeight, scrollTop: prev, offsets, heights }),
      );
    },
    { isActive: active && messages.length > 0 },
  );

  const { start, end } = visibleSlice(scrollTop, viewportHeight, offsets, heights);
  const clip = start < offsets.length ? Math.max(0, scrollTop - (offsets[start] ?? 0)) : 0;

  return (
    <Box flexDirection="column">
      {messages.slice(start, end).map((message, k) => {
        const i = start + k;
        const lines = k === 0 ? message.lines.slice(clip) : message.lines;
        return (
          <Box key={i} flexDirection="column">
            {lines.map((line, j) => (
              <Text key={j} color={i === selected ? 'green' : 'white'} bold={i === selected}>
                {i === selected && j === 0 ? '▸ ' : ''}
                {line}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
