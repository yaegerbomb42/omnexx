import { Box, Text } from 'ink';
import { AMBER, CYAN, GRAY, GREEN, PINK, RED } from './colors.js';

export type Mood =
  'hello' | 'idle' | 'sleepy' | 'listening' | 'thinking' | 'working' | 'happy' | 'sad' | 'startled';

/** Ticks a reaction (happy, sad, startled, hello) is held (~3 s at 300 ms). */
export const REACTION_TICKS = 10;
/** Idle ticks before Nex dozes off (~60 s at 300 ms). */
export const SLEEP_TICKS = 200;

/** Rows are all exactly this wide, so the layout never shifts between frames. */
export const NEX_WIDTH = 13;

export interface MascotFrame {
  rows: [string, string, string, string, string];
  /** What Nex says, shown in its speech bubble. */
  caption: string;
}

/** Where the eye looks: x left/center/right, y up/middle/down. */
export interface Look {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

const pad = (s: string): string => s.padEnd(NEX_WIDTH, ' ').slice(0, NEX_WIDTH);

/** Put `iris` into the eye's row at the column for `x` (rows 1 and 3 are narrower than row 2). */
function place(row: string, iris: string, x: -1 | 0 | 1, wide: boolean): string {
  const start = wide ? [3, 5, 7][x + 1] : [4, 5, 6][x + 1];
  const at = start ?? 5;
  return pad(row.slice(0, at) + iris + row.slice(at + iris.length));
}

const TOP = '   .-~~~-.';
const R1 = '  /       \\';
const R2 = ' |         |';
const R3 = '  \\       /';
const BOTTOM = "   '-...-'";
/** Row 3 with rosy cheeks, for happy moments. */
const R3_BLUSH = '  \\ ~   ~ /';

/** The open eye with the iris looking at `look`. */
function eye(look: Look, iris = '(@)', top = TOP): MascotFrame['rows'] {
  const rows = [top, R1, R2, R3, BOTTOM].map(pad) as MascotFrame['rows'];
  const r = look.y + 2;
  rows[r] = place(rows[r] ?? '', iris, look.x, r === 2);
  return rows;
}

/** Rosy cheeks under the eye. */
function blush(rows: MascotFrame['rows']): MascotFrame['rows'] {
  const r = [...rows] as MascotFrame['rows'];
  if (!/[(][^)]+[)]/.test(r[3])) r[3] = pad(R3_BLUSH);
  return r;
}

/** A glance around the room for idle moments: mostly center, sometimes left or right. */
const IDLE_LOOKS: Look[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 0 },
  { x: 1, y: -1 },
  { x: 0, y: 0 },
];

/**
 * Nex: one big eye, five rows by thirteen columns. It looks where `look` says (the TUI points it
 * at the cursor while you type), blinks, and changes with mood. A pure function of mood, tick and
 * look so tests can pin frames; only single-width characters.
 */
export function mascotFrame(
  mood: Mood,
  tick: number,
  say = '',
  look: Look = { x: 0, y: 0 },
): MascotFrame {
  const blink = tick % 17 === 16;
  const closed = (): MascotFrame['rows'] =>
    [TOP, '  /_______\\', R2, R3, BOTTOM].map(pad) as MascotFrame['rows'];
  switch (mood) {
    case 'hello':
      return {
        rows: blink
          ? closed()
          : blush(eye({ x: tick % 4 < 2 ? -1 : 1, y: 0 }, '(@)', '   .-~~~-. o/')),
        caption: say || 'hi! what are we building?',
      };
    case 'idle':
      return {
        rows: blink ? closed() : eye(IDLE_LOOKS[Math.floor(tick / 8) % IDLE_LOOKS.length] ?? look),
        caption: say,
      };
    case 'listening':
      return { rows: blink ? closed() : eye(look), caption: say || 'listening…' };
    case 'thinking': {
      const x = ([-1, 0, 1, 0] as const)[Math.floor(tick / 2) % 4] ?? 0;
      return {
        rows: eye({ x, y: -1 }, '(o)'),
        caption: say || `thinking${'.'.repeat((tick % 3) + 1)}`,
      };
    }
    case 'working': {
      const x = ([-1, 1, 0, 1, -1, 0] as const)[tick % 6] ?? 0;
      return { rows: blink ? closed() : eye({ x, y: look.y }), caption: say || 'on it' };
    }
    case 'happy': {
      const spark = tick % 2 === 0 ? '*' : '+';
      return {
        rows: blush(
          eye(
            { x: 0, y: 0 },
            say.includes('milestone') ? '(♥)' : '(^)',
            ` ${spark} .-~~~-. ${spark}`,
          ),
        ),
        caption: say || 'yay, it works!',
      };
    }
    case 'sad':
      return {
        rows: [TOP, '  /-------\\', R2, place(pad(R3), '(.)', 0, false), BOTTOM].map(
          pad,
        ) as MascotFrame['rows'],
        caption: say || 'oops, trying again',
      };
    case 'startled':
      return { rows: eye({ x: 0, y: 0 }, '(O)', ' ! .-~~~-. !'), caption: say || 'stopping!' };
    case 'sleepy': {
      const z = ['  z', ' zZ', 'zZz'][Math.floor(tick / 3) % 3] ?? 'z';
      return {
        rows: [`${TOP}${z}`, '  /_______\\', ' |---------|', R3, BOTTOM].map(
          pad,
        ) as MascotFrame['rows'],
        caption: say || 'zz… type to wake me',
      };
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

const IRIS_COLOR: Record<Mood, string> = {
  hello: PINK,
  idle: CYAN,
  sleepy: GRAY,
  listening: CYAN,
  thinking: AMBER,
  working: CYAN,
  happy: PINK,
  sad: RED,
  startled: AMBER,
};

export function Mascot({
  mood,
  tick,
  say,
  look,
}: {
  mood: Mood;
  tick: number;
  say?: string;
  look?: Look;
}) {
  const f = mascotFrame(mood, tick, say, look);
  return (
    <Box flexDirection="column" width={NEX_WIDTH}>
      {f.rows.map((r, i) => {
        // The iris and cheeks get their own colour; the lid stays the mood colour.
        const parts = r.split(/([(][^)]{1,2}[)]|~(?= ))/);
        return (
          <Text key={i} color={MOOD_COLOR[mood]}>
            {parts.map((p, k) =>
              k % 2 === 1 ? (
                <Text key={k} color={p.startsWith('~') ? PINK : IRIS_COLOR[mood]} bold>
                  {p}
                </Text>
              ) : (
                p
              ),
            )}
          </Text>
        );
      })}
    </Box>
  );
}

/** Nex's speech bubble, left of Nex. */
export function SpeechBubble({ text, width }: { text: string; width: number }) {
  if (!text) return null;
  const t = text.length > width - 6 ? `${text.slice(0, width - 7)}…` : text;
  return (
    <Box flexDirection="column">
      <Text color={GRAY}>{`  ╭${'─'.repeat(t.length + 2)}╮`}</Text>
      <Text>
        <Text color={GRAY}>{'─┤ '}</Text>
        <Text>{t}</Text>
        <Text color={GRAY}>{' │'}</Text>
      </Text>
      <Text color={GRAY}>{`  ╰${'─'.repeat(t.length + 2)}╯`}</Text>
    </Box>
  );
}
