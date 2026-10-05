import type { CliIO } from './io.js';

/** Brand palette (see omnexx-brand/BRAND.md): bright green primary, cyan secondary, dim gray. */
const GREEN = [0, 255, 65] as const;
const CYAN = [0, 229, 255] as const;
const GRAY = [102, 102, 102] as const;

const LARGE = [
  ' ██████╗ ███╗   ███╗███╗   ██╗███████╗██╗  ██╗██╗  ██╗',
  '██╔═══██╗████╗ ████║████╗  ██║██╔════╝╚██╗██╔╝╚██╗██╔╝',
  '██║   ██║██╔████╔██║██╔██╗ ██║█████╗   ╚███╔╝  ╚███╔╝ ',
  '██║   ██║██║╚██╔╝██║██║╚██╗██║██╔══╝   ██╔██╗  ██╔██╗ ',
  '╚██████╔╝██║ ╚═╝ ██║██║ ╚████║███████╗██╔╝ ██╗██╔╝ ██╗',
  ' ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝',
];

export const TAGLINE = 'long-running autonomous agent';

export interface Brand {
  green: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
}

/** Colors only on a TTY, never with NO_COLOR; truecolor when the terminal says so, else 16-color. */
export function brand(io: Pick<CliIO, 'env' | 'isTTY'>): Brand {
  const env = io.env;
  const on = (io.isTTY || Boolean(env.FORCE_COLOR)) && !env.NO_COLOR && env.TERM !== 'dumb';
  const truecolor = /truecolor|24bit/i.test(env.COLORTERM ?? '');
  const paint =
    (rgb: readonly [number, number, number], fallback: number) =>
    (s: string): string => {
      if (!on) return s;
      const open = truecolor ? `38;2;${rgb.join(';')}` : String(fallback);
      return `\x1b[${open}m${s}\x1b[39m`;
    };
  return { green: paint(GREEN, 92), cyan: paint(CYAN, 96), dim: paint(GRAY, 90) };
}

/** The splash: big wordmark when the terminal is wide enough, the plain lowercase name otherwise. */
export function banner(io: Pick<CliIO, 'env' | 'isTTY'>, columns = 80, version?: string): string {
  const b = brand(io);
  const mark = columns >= 60 ? LARGE.map((l) => b.green(l)).join('\n') : b.green('omnexx');
  const ver = version ? ` ${b.dim(`v${version}`)}` : '';
  return ['', mark, '', `${b.cyan('$ omnexx')}${ver}`, `> ${TAGLINE}`, ''].join('\n');
}
