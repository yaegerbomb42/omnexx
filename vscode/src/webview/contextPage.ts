/**
 * The Context explorer: every file that feeds the agent's context in this workspace, with its
 * token cost, a Pinned / Optional / Hidden switch for sections, and Edit or View to open it.
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

let files: ContextFile[] = [];
let runId: string | null = null;
let loading = true;

const MODES: { id: Mode; label: string; title: string }[] = [
  { id: 'pinned', label: 'Pinned', title: 'Sent with every step' },
  { id: 'optional', label: 'Optional', title: 'Listed; the agent opens it when it needs it' },
  { id: 'hidden', label: 'Hidden', title: 'Never sent' },
];

function page(): HTMLElement {
  const el = document.getElementById('ctxpage');
  if (!el) throw new Error('missing #ctxpage');
  return el;
}

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

function draw(): void {
  const el = page();
  const sum = (m: Mode) =>
    files.filter((f) => f.mode === m && f.exists).reduce((n, f) => n + f.tokens, 0);
  const head = `<div class="set-head"><button class="ghost back" data-ctx-close>← Back to chat</button><h2>Context</h2></div>`;
  if (loading) {
    el.innerHTML = `${head}<p class="hint"><span class="spinner"></span> Reading context files…</p>`;
    return;
  }
  const sections = files.filter((f) => f.section);
  const notes = files.filter((f) => !f.section);
  el.innerHTML = `${head}
<section class="set-section"><h3>What the agent sees</h3>
  <div class="ctx-sum"><div><b>~${formatTokens(sum('pinned'))}</b><span>sent every step</span></div><div><b>~${formatTokens(sum('optional'))}</b><span>on request</span></div><div><b>~${formatTokens(sum('hidden'))}</b><span>hidden</span></div></div>
  <p class="hint">${runId ? `From the latest run here (${escapeHtml(runId)}). ` : 'No run here yet: sections appear after the first one. '}Omnexx keeps managing what's inside; you decide what goes in.</p>
  ${sections.length ? `<ul class="cfiles">${sections.map(rowHtml).join('')}</ul>` : ''}
</section>
<section class="set-section"><h3>Notes you can edit</h3><ul class="cfiles">${notes.map(rowHtml).join('')}</ul>
  <p class="hint">Edits are read on the next cycle. Notes carry over to later runs in this repo.</p>
</section>`;
}

export function isOpen(): boolean {
  return !page().hidden;
}

export function open(post: Post): void {
  document.body.classList.add('ctx-open');
  page().hidden = false;
  loading = files.length === 0;
  draw();
  post({ type: 'contextFiles' });
}

export function close(): void {
  document.body.classList.remove('ctx-open');
  page().hidden = true;
}

export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type !== 'contextFiles') return false;
  files = (m.files as ContextFile[] | undefined) ?? [];
  runId = typeof m.runId === 'string' ? m.runId : null;
  loading = false;
  if (isOpen()) draw();
  return true;
}

export function wire(post: Post): void {
  page().addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-ctx-close]')) {
      close();
      return;
    }
    const path = t.closest<HTMLElement>('[data-ctx-open]')?.dataset.ctxOpen;
    if (path) {
      post({ type: 'openContextFile', path });
      return;
    }
    const btn = t.closest<HTMLElement>('[data-ctx-mode]');
    if (btn?.dataset.ctxId && btn.dataset.ctxMode) {
      const id = btn.dataset.ctxId;
      const mode = btn.dataset.ctxMode as Mode;
      files = files.map((f) => (f.section === id ? { ...f, mode } : f));
      draw();
      post({ type: 'setSectionMode', id, mode });
    }
  });
  page().addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}
