/**
 * Terminal color roles — the CLI side of the shared token language (design spec §3.3).
 * Every role is a semantic name, never a literal hue, so components stop mixing sources.
 * Values are the dark-theme ANSI truecolors, 1:1 with the webview hex values.
 */
export const BG = '#0c0f14';
export const SURFACE = '#11151b';
export const TEXT = '#d8dee9';
export const MUTED = '#959fa8';
export const ACCENT = '#66bfff';
export const OK = '#3fb950';
export const WARN = '#f5a524';
export const BAD = '#f14c4c';
export const INFO = '#2dd4bf';
export const VIOLET = '#a78bfa';

/** The mascot's iris/cheek hue — a fixed brand accent, not a themable role. */
export const PINK = '#f472b6';
