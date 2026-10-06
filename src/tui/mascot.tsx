import { Box, Text } from 'ink';
import { CYAN, GRAY, GREEN, RED } from './colors.js';

export type Mood = 'idle' | 'thinking' | 'working' | 'happy' | 'sad';

/** Ticks a happy or sad face is held after a commit or rejection (~3 s at 300 ms). */
export const REACTION_TICKS = 10;

export interface MascotFrame {
  rows: [string, string, string];
  /** Shown to the right: what the creature is up to. */
  caption: string;
}

/**
 * Nex, three rows by five columns. A pure function of mood and tick so tests can pin frames.
 * Only single-width characters: Ink measures them the same in every terminal.
 */
export function mascotFrame(mood: Mood, tick: number): MascotFrame {
  const step = tick % 2 === 0;
  const head = ' ▗▄▖ ';
  const stand = ' ▘ ▝ ';
  const walk = step ? ' ▘ ▝ ' : ' ▝ ▘ ';
  switch (mood) {
    case 'happy':
      return { rows: [step ? '\\▗▄▖/' : ' ▗▄▖ ', '▐^‿^▌', walk], caption: 'committed!' };
    case 'sad':
      return { rows: [head, '▐;_;▌', stand], caption: 'rejected, trying again' };
    case 'thinking': {
      const dots = '.'.repeat((tick % 3) + 1);
      return { rows: [head, tick % 4 < 2 ? '▐o.o▌' : '▐o.O▌', stand], caption: `thinking${dots}` };
    }
    case 'working': {
      const eyes = ['▐o.o▌', '▐ o.▌', '▐o.o▌', '▐.o ▌'][Math.floor(tick / 3) % 4] ?? '▐o.o▌';
      return { rows: [head, eyes, walk], caption: 'working' };
    }
    case 'idle':
      // A blink every ~5 s.
      return { rows: [head, tick % 16 === 15 ? '▐-.-▌' : '▐o.o▌', stand], caption: '' };
  }
}

const MOOD_COLOR: Record<Mood, string> = {
  idle: GREEN,
  thinking: CYAN,
  working: GREEN,
  happy: GREEN,
  sad: RED,
};

export function Mascot({ mood, tick }: { mood: Mood; tick: number }) {
  const f = mascotFrame(mood, tick);
  return (
    <Box flexDirection="column" marginRight={1} width={5}>
      {f.rows.map((r, i) => (
        <Text key={i} color={MOOD_COLOR[mood]}>
          {r}
        </Text>
      ))}
    </Box>
  );
}

export function MascotCaption({ mood, tick }: { mood: Mood; tick: number }) {
  const { caption } = mascotFrame(mood, tick);
  return caption ? <Text color={GRAY}>{caption}</Text> : null;
}
