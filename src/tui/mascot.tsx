import { Box, Text } from 'ink';
import { CYAN, GRAY, GREEN, RED } from './colors.js';

export type Mood =
  'hello' | 'idle' | 'sleepy' | 'listening' | 'thinking' | 'working' | 'happy' | 'sad' | 'startled';

/** Ticks a reaction (happy, sad, startled, hello) is held (~3 s at 300 ms). */
export const REACTION_TICKS = 10;
/** Idle ticks before Nex dozes off (~60 s at 300 ms). */
export const SLEEP_TICKS = 200;

/** Rows are all exactly this wide, so the layout never shifts between frames. */
export const NEX_WIDTH = 11;

export interface MascotFrame {
  rows: [string, string, string, string, string];
  /** What Nex says, shown in its speech bubble. */
  caption: string;
}

const pad = (s: string): string => s.padEnd(NEX_WIDTH, ' ').slice(0, NEX_WIDTH);

/**
 * Nex, five rows by eleven columns: an antenna, a round head with a face, and little feet. A pure
 * function of mood and tick so tests can pin frames. Only single-width characters, so Ink
 * measures every frame the same in every terminal.
 */
export function mascotFrame(mood: Mood, tick: number, say = ''): MascotFrame {
  const step = tick % 2 === 0;
  const sway = ['  \\  ', '  |  ', '  /  ', '  |  '][Math.floor(tick / 2) % 4] ?? '  |  ';
  const antenna = (a: string): string => pad(`   ${a}`);
  const head = pad('  ╭─────╮');
  const face = (eyes: string, mouth: string, l = '│', r = '│'): [string, string] => [
    pad(`  ${l} ${eyes} ${r}`),
    pad(`  ${l}  ${mouth}  ${r}`),
  ];
  const stand = pad('  ╰┬───┬╯');
  const walk = step ? pad('  ╰┬───┬╯') : pad('  ╰─┬─┬─╯');
  switch (mood) {
    case 'hello': {
      // Waves one arm.
      const arm = step ? '/' : '_';
      return {
        rows: [antenna(sway), head, pad(`  │ ^ ^ │${arm}`), pad('  │  v  │'), stand],
        caption: say || 'hi! what are we building?',
      };
    }
    case 'idle': {
      const blink = tick % 16 === 15;
      const [e, m] = face(blink ? '- -' : 'o o', 'u');
      return { rows: [antenna(sway), head, e, m, stand], caption: say };
    }
    case 'sleepy': {
      const z = ['z  ', ' z ', '  Z'][Math.floor(tick / 3) % 3] ?? 'z';
      const [e, m] = face('- -', 'o');
      return {
        rows: [pad(`     .    ${z}`), head, e, m, stand],
        caption: say || 'zz… type to wake me',
      };
    }
    case 'listening': {
      // Eyes drop toward the input box.
      const [e, m] = face('. .', 'o');
      return { rows: [antenna('  |  '), head, e, m, stand], caption: say || 'listening…' };
    }
    case 'thinking': {
      const dots = '.'.repeat((tick % 3) + 1);
      const [e, m] = face(tick % 4 < 2 ? "' '" : '` `', '~');
      return {
        rows: [antenna(` ${'*+x+'[tick % 4] ?? '*'}  `), head, e, m, stand],
        caption: say || `thinking${dots}`,
      };
    }
    case 'working': {
      const eyes = ['o o', ' oo', 'o o', 'oo '][Math.floor(tick / 3) % 4] ?? 'o o';
      const [e, m] = face(eyes, '-');
      return { rows: [antenna(sway), head, e, m, walk], caption: say || 'on it' };
    }
    case 'happy': {
      // Arms up, sparkles around the antenna.
      const spark = step ? '*' : '+';
      return {
        rows: [pad(` ${spark} \\|/ ${spark}`), head, pad('  │ ^ ^ │'), pad(' \\│  w  │/'), walk],
        caption: say || 'yay, it works!',
      };
    }
    case 'sad': {
      const [e, m] = face('; ;', 'n');
      return { rows: [antenna('  .  '), head, e, m, stand], caption: say || 'oops, trying again' };
    }
    case 'startled': {
      const [e, m] = face('O O', 'o');
      return { rows: [antenna(' ! ! '), head, e, m, stand], caption: say || 'stopping!' };
    }
  }
}

const MOOD_COLOR: Record<Mood, string> = {
  hello: GREEN,
  idle: GREEN,
  sleepy: GRAY,
  listening: CYAN,
  thinking: CYAN,
  working: GREEN,
  happy: GREEN,
  sad: RED,
  startled: CYAN,
};

export function Mascot({ mood, tick, say }: { mood: Mood; tick: number; say?: string }) {
  const f = mascotFrame(mood, tick, say);
  return (
    <Box flexDirection="column" width={NEX_WIDTH}>
      {f.rows.map((r, i) => (
        <Text key={i} color={MOOD_COLOR[mood]}>
          {r}
        </Text>
      ))}
    </Box>
  );
}

/** Nex's speech bubble, left of Nex. */
export function SpeechBubble({ text, width }: { text: string; width: number }) {
  if (!text) return null;
  const t = text.length > width - 6 ? `${text.slice(0, width - 7)}…` : text;
  return (
    <Box flexDirection="column">
      <Text color={GRAY}>{`╭${'─'.repeat(t.length + 2)}╮ `}</Text>
      <Text>
        <Text color={GRAY}>{'│ '}</Text>
        <Text>{t}</Text>
        <Text color={GRAY}>{' ├─'}</Text>
      </Text>
      <Text color={GRAY}>{`╰${'─'.repeat(t.length + 2)}╯ `}</Text>
    </Box>
  );
}
