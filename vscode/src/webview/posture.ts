/**
 * The Execution Posture pill: the chat's [execution] mode (efficient / normal / extreme) as a
 * three-segment glass control, shown in the chat header and again in Settings → Agent.
 *
 * The mode itself lives in config, not in the chat server: the extension host reads the
 * effective value (OMNEXX_EXECUTION_MODE, then the project's omnexx.toml, then the user
 * config.toml) and answers `executionMode`; a pick posts `setExecutionMode`, the host writes
 * `mode` into the user config's [execution] table, and runs pick it up at the next cycle
 * boundary (the supervisor's config refresh). When a stronger layer (env, project file)
 * overrides the user value, the host reports that source and the pill shows it, with a note.
 */
import { escapeHtml } from './render.js';

type Post = (msg: Record<string, unknown>) => void;

export type ExecutionMode = 'efficient' | 'normal' | 'extreme';
export type ModeSource = 'env' | 'project' | 'user' | 'default';

export interface ModeMeta {
  id: ExecutionMode;
  icon: string;
  name: string;
  caption: string;
}

/** The three postures, with the one-line caption each shows while active. */
export const MODES: readonly ModeMeta[] = [
  {
    id: 'efficient',
    icon: '⚡',
    name: 'Efficient',
    caption: 'Optimized for speed and token efficiency. Great for most tasks.',
  },
  {
    id: 'normal',
    icon: '⚖️',
    name: 'Normal',
    caption: 'The balanced default: standard planning, context and budgets.',
  },
  {
    id: 'extreme',
    icon: '🔥',
    name: 'Extreme',
    caption: 'Maximum autonomy: full planning, the largest budgets, swarm subagents.',
  },
];

export const isExecutionMode = (v: unknown): v is ExecutionMode =>
  v === 'efficient' || v === 'normal' || v === 'extreme';

export const metaFor = (mode: ExecutionMode): ModeMeta =>
  MODES.find((m) => m.id === mode) ?? (MODES[1] as ModeMeta);

/** Why the pill may not reflect a pick: a stronger config layer is in charge. */
export function sourceNote(source: ModeSource): string {
  if (source === 'env')
    return 'Set by the OMNEXX_EXECUTION_MODE environment variable, which wins over config files.';
  if (source === 'project')
    return "Set in this project's omnexx.toml, which wins over your user settings; picks save to your user config instead.";
  return 'Saved to your config.toml; a running task picks it up at its next cycle.';
}

let current: ExecutionMode = 'normal';
let source: ModeSource = 'default';

/** The pill: three gradient segments, the active mode's caption, and any override note. */
export function pillHtml(): string {
  const meta = metaFor(current);
  const buttons = MODES.map(
    (m) =>
      `<button data-posture="${m.id}" aria-pressed="${String(m.id === current)}" title="${escapeHtml(m.caption)}"><span class="posture-ico" aria-hidden="true">${m.icon}</span>${m.name}</button>`,
  ).join('');
  return `<div class="posture-pill" role="group" aria-label="Execution posture">${buttons}</div>
<p class="posture-caption">${escapeHtml(meta.caption)}</p>
<p class="posture-note">${escapeHtml(sourceNote(source))}</p>`;
}

/** The Settings card wrapping the pill (the chat header uses the bare pill). */
export function cardHtml(): string {
  return `<div class="posture-card">
<div class="posture-title">Execution Posture</div>
<div data-posture-slot>${pillHtml()}</div>
</div>`;
}

/** Fill every pill slot on the page (chat header, settings card) with the current state. */
export function render(): void {
  document.querySelectorAll<HTMLElement>('[data-posture-slot]').forEach((slot) => {
    slot.innerHTML = pillHtml();
  });
}

/** Ask the extension host for the effective mode. */
export function request(post: Post): void {
  post({ type: 'executionMode' });
}

/** The host's answer: the effective mode and which config layer set it. */
export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type !== 'executionMode') return false;
  if (isExecutionMode(m.mode)) current = m.mode;
  if (m.source === 'env' || m.source === 'project' || m.source === 'user' || m.source === 'default')
    source = m.source;
  render();
  return true;
}

/** Segment clicks (delegated: the pill is re-rendered in place, in two places at once). */
export function wire(post: Post): void {
  render();
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const mode = t?.closest<HTMLElement>('[data-posture]')?.dataset.posture;
    if (!isExecutionMode(mode) || mode === current) return;
    current = mode;
    render();
    post({ type: 'setExecutionMode', mode });
  });
}
