import { Box, Text } from 'ink';
import { parseDuration } from '../config/duration.js';
import { INFO, MUTED, OK } from './colors.js';
import { BORDER, SPACE } from './tokens.js';

/**
 * The guided way into an autonomous run: pick how long it works (or type a time), then say what
 * to work on (or nothing: keep improving the repo). `/autonomous` with no arguments opens it.
 */
export const AUTO_TIMES: readonly { label: string; value: string }[] = [
  { label: '30 minutes', value: '30m' },
  { label: '1 hour', value: '1h' },
  { label: '2 hours', value: '2h' },
  { label: '4 hours', value: '4h' },
  { label: '8 hours · a workday', value: '8h' },
  { label: '12 hours · overnight', value: '12h' },
  { label: '24 hours', value: '24h' },
  { label: 'custom…', value: '' },
];

/** `goal` is set when the person typed one before picking the time. */
export type AutoSetup =
  | { step: 'time'; cursor: number; goal?: string }
  | { step: 'custom'; goal?: string }
  | { step: 'goal'; time: string };

/** A typed time ("90m", "3h", "1d", "1h30m", or a bare number of hours), or undefined. */
export function readTime(text: string): string | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  const value = /^\d+(\.\d+)?$/.test(t) ? `${t}h` : t;
  try {
    return parseDuration(value) >= 60_000 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** "8h" → "8 hours", "90m" → "90 minutes". */
export function timeLabel(value: string): string {
  const known = AUTO_TIMES.find((t) => t.value === value);
  if (known) return known.label.split(' · ')[0] ?? value;
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value);
  if (!m) return value;
  const unit = { m: 'minute', h: 'hour', d: 'day' }[m[2] as 'm' | 'h' | 'd'];
  return `${m[1] ?? ''} ${unit}${m[1] === '1' ? '' : 's'}`;
}

export function AutoTimePicker({ state, width }: { state: AutoSetup; width: number }) {
  if (state.step !== 'time') return null;
  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER.panel}
      borderColor={OK}
      paddingX={SPACE.sm}
      width={width}
    >
      <Text>
        <Text color={OK} bold>
          autonomous run · how long should it work?
        </Text>
        <Text color={MUTED}>{'  ↑↓ or 1-8 · enter choose · esc cancel'}</Text>
      </Text>
      {AUTO_TIMES.map((t, i) => (
        <Text key={t.label} inverse={i === state.cursor}>
          <Text color={i === state.cursor ? INFO : MUTED}>{`${String(i + 1)}  `}</Text>
          <Text>{t.label}</Text>
        </Text>
      ))}
      <Text color={MUTED}>
        next: what it should work on. It plans, works, checks every change, and stops at the time.
      </Text>
    </Box>
  );
}
