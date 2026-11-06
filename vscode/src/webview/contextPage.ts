/**
 * The Context explorer: every file that feeds the agent's context in this workspace, with its
 * token cost, a Pinned / Optional / Hidden switch for sections, and Edit or View to open it.
 *
 * It renders as the "Files & Sections" tab inside the Context Cockpit (inspector.ts), not its
 * own overlay: the cockpit binds itself as the tab host via bindTabHost(), and open()/close()
 * switch tabs through it. Clicks inside the tab reach click() through the cockpit's wiring.
 */
import { escapeHtml, formatTokens } from './render.js';

type Post = (msg: Record<string, unknown>) => void;
type Mode = 'pinned' | 'optional' | 'hidden';

interface ContextFile {
  id: string;
  label: string;
  about: string;
  path: string;
  tokens: number;
  exists: boolean;
  editable: boolean;
  section?: string;
  mode?: Mode;
}

/** The cockpit side of the tab: show one tab, report which is showing, redraw the cockpit. */
export interface ContextTabHost {
  showFiles(): void;
  showContext(): void;
  filesOpen(): boolean;
  refresh(): void;
}

let host: ContextTabHost | null = null;

/** The cockpit registers itself once, at wire time; until then open()/close() only fetch. */
export function bindTabHost(h: ContextTabHost): void {
  host = h;
}

let files: ContextFile[] = [];
let runId: string | null = null;
let loading = true;

const MODES: { id: Mode; label: string; title: string }[] = [
  { id: 'pinned', label: 'Pinned', title: 'Sent with every step' },
  { id: 'optional', label: 'Optional', title: 'Listed; the agent opens it when it needs it' },
  { id: 'hidden', label: 'Hidden', title: 'Never sent' },
];

function rowHtml(f: ContextFile): string {
  const modes = f.section
    ? `<div class="seg mini" role="group" aria-label="${escapeHtml(f.label)} mode">${MODES.map(
        (m) =>
          `<button data-ctx-mode="${m.id}" data-ctx-id="${escapeHtml(f.section ?? '')}" aria-pressed="${String(f.mode === m.id)}" title="${m.title}">${m.label}</button>`,
      ).join('')}</div>`
    : '';
  const size = f.exists ? `~${formatTokens(f.tokens)} tok` : f.editable ? 'empty' : 'not yet';
  const open = f.editable ? 'Edit' : 'View';
  return `<li class="cfile${f.mode ? ` m-${f.mode}` : ''}"><div class="cf-main"><div class="cf-top"><span class="cf-name">${escapeHtml(f.label)}</span><span class="cf-size">${size}</span></div><div class="cf-about">${escapeHtml(f.about)}</div>${modes}</div><button class="ghost" data-ctx-open="${escapeHtml(f.path)}"${!f.exists && !f.editable ? ' disabled' : ''}>${open}</button></li>`;
}

/** The tab's content: the token split across pinned / optional / hidden, then the file rows. */
export function html(): string {
  if (loading) return '<p class="hint"><span class="spinner"></span> Reading context files…</p>';
  const sum = (m: Mode) =>
    files.filter((f) => f.mode === m && f.exists).reduce((n, f) => n + f.tokens, 0);
  const pinned = sum('pinned');
  const optional = sum('optional');
  const hidden = sum('hidden');
  const total = pinned + optional + hidden;
  const share = (n: number): string =>
    total > 0 ? ` · ${String(Math.round((n / total) * 100))}%` : '';
  const sections = files.filter((f) => f.section);
  const notes = files.filter((f) => !f.section);
  return `<section class="set-section"><h3>What the agent sees</h3>
  <div class="ctx-sum"><div><b>~${formatTokens(pinned)}</b><span>sent every step${share(pinned)}</span></div><div><b>~${formatTokens(optional)}</b><span>on request${share(optional)}</span></div><div><b>~${formatTokens(hidden)}</b><span>hidden${share(hidden)}</span></div></div>
  <p class="hint">${runId ? `From the latest run here (${escapeHtml(runId)}). ` : 'No run here yet: sections appear after the first one. '}Omnexx keeps managing what's inside; you decide what goes in.</p>
  ${sections.length ? `<ul class="cfiles">${sections.map(rowHtml).join('')}</ul>` : ''}
</section>
<section class="set-section"><h3>Notes you can edit</h3><ul class="cfiles">${notes.map(rowHtml).join('')}</ul>
  <p class="hint">Edits are read on the next cycle. Notes carry over to later runs in this repo.</p>
</section>`;
}

/** True while the cockpit is showing this tab. */
export function isOpen(): boolean {
  return host?.filesOpen() ?? false;
}

/** Show the Files tab in the cockpit (and ask for the file list). */
export function open(post: Post): void {
  loading = files.length === 0;
  post({ type: 'contextFiles' });
  host?.showFiles();
}

/** Back to the cockpit's Context tab. */
export function close(): void {
  host?.showContext();
}

export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type !== 'contextFiles') return false;
  files = (m.files as ContextFile[] | undefined) ?? [];
  runId = typeof m.runId === 'string' ? m.runId : null;
  loading = false;
  if (host?.filesOpen()) host.refresh();
  return true;
}

/** Clicks inside the Files tab; true when handled. */
export function click(t: Element, post: Post): boolean {
  if (t.closest('[data-ctx-close]')) {
    close();
    return true;
  }
  const path = t.closest<HTMLElement>('[data-ctx-open]')?.dataset.ctxOpen;
  if (path) {
    post({ type: 'openContextFile', path });
    return true;
  }
  const btn = t.closest<HTMLElement>('[data-ctx-mode]');
  if (btn?.dataset.ctxId && btn.dataset.ctxMode) {
    const id = btn.dataset.ctxId;
    const mode = btn.dataset.ctxMode as Mode;
    files = files.map((f) => (f.section === id ? { ...f, mode } : f));
    host?.refresh();
    post({ type: 'setSectionMode', id, mode });
    return true;
  }
  return false;
}

/**
 * Kept so the chat.ts call site stays unchanged. This page renders inside the cockpit now,
 * not its own overlay: clicks inside the tab reach click() through the cockpit's wiring, and
 * Escape closes the cockpit.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- parameter kept so the chat.ts call site is unchanged; clicks route through the cockpit.
export function wire(_post: Post): void {
  // No listeners here: the cockpit owns the tab's DOM.
}
