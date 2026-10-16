/**
 * The installed-skills list in settings: an on/off switch and Remove (hide from omnexx, or delete
 * the folder after naming it) on every skill from every source. No DOM, so tests can import it.
 */
import { escapeHtml, formatTokens } from './render.js';
import { emptyHtml } from './settingsLayout.js';

export interface Installed {
  name: string;
  description: string;
  path: string;
  sourceLabel: string;
  enabled: boolean;
  hidden?: boolean;
  /** omnexx's own folder; anything else belongs to Claude Code, the repo or a [skills] dir. */
  owned?: boolean;
  tokens: number;
  from?: string;
}

/** The view state the installed list draws from. */
export interface ListView {
  confirming?: string | undefined;
  showHidden: boolean;
}

/** The folder a skill lives in (what "delete files" removes). */
export const skillFolder = (path: string): string => path.replace(/[\\/]SKILL\.md$/, '');

/** The message for a remove choice: hide keeps the files; delete names the folder it removes. */
export function removeMessage(s: Installed, mode: 'hide' | 'delete'): Record<string, unknown> {
  return mode === 'hide'
    ? { type: 'skillsRemove', name: s.name, mode }
    : { type: 'skillsRemove', name: s.name, mode, path: skillFolder(s.path) };
}

function confirmHtml(s: Installed): string {
  const n = escapeHtml(s.name);
  const folder = escapeHtml(skillFolder(s.path));
  const what = s.owned
    ? 'You installed it with omnexx.'
    : `It belongs to ${escapeHtml(s.sourceLabel)}; hiding keeps it there for other tools.`;
  return `<div class="sk-confirm" role="group" aria-label="Remove ${n}"><p class="hint">${what}</p><div class="ci-actions"><button class="primary small" data-sk-hide="${n}">Hide from omnexx</button><button class="danger-btn small" data-sk-delete="${n}" title="Deletes ${folder}">Delete files</button><button class="ghost small" data-sk-remove-cancel>Cancel</button></div><p class="hint sk-path">Delete removes <code>${folder}</code> from disk.</p></div>`;
}

function rowHtml(s: Installed, view: ListView): string {
  const n = escapeHtml(s.name);
  const cost = s.enabled ? `~${formatTokens(s.tokens)} tok` : 'off';
  const toggle = `<label class="mcp-switch" title="${s.enabled ? 'On: offered to the agent' : 'Off: never offered'}"><input type="checkbox" aria-label="Use ${n}" data-sk-toggle="${n}"${s.enabled ? ' checked' : ''}><span></span></label>`;
  const actions = `<button class="ghost small" data-sk-open="${escapeHtml(s.path)}" title="Open SKILL.md">Open</button><button class="ghost small" data-sk-remove="${n}" aria-expanded="${String(view.confirming === s.name)}">Remove</button>`;
  return `<li class="sk${s.enabled ? '' : ' off'}"><div class="sk-main"><div class="sk-top"><span class="sk-name">${n}</span><span class="sk-badge">${escapeHtml(s.sourceLabel)}</span><span class="sk-tok">${cost}</span></div><div class="sk-about">${escapeHtml(s.description)}</div><div class="sk-actions">${actions}</div>${view.confirming === s.name ? confirmHtml(s) : ''}</div>${toggle}</li>`;
}

function hiddenHtml(hidden: Installed[], view: ListView): string {
  if (!hidden.length) return '';
  const head = `<button class="link" data-sk-show-hidden aria-expanded="${String(view.showHidden)}">${String(hidden.length)} hidden from omnexx ${view.showHidden ? '▴' : '▾'}</button>`;
  if (!view.showHidden) return head;
  const rows = hidden
    .map(
      (s) =>
        `<li class="sk off"><div class="sk-main"><div class="sk-top"><span class="sk-name">${escapeHtml(s.name)}</span><span class="sk-badge">${escapeHtml(s.sourceLabel)}</span></div></div><button class="ghost small" data-sk-unhide="${escapeHtml(s.name)}">Bring back</button></li>`,
    )
    .join('');
  return `${head}<ul class="sk-list">${rows}</ul>`;
}

/** The installed skills: a switch and Remove on every one, hidden ones folded away. */
export function listHtml(all: Installed[], view: ListView): string {
  const shown = all.filter((s) => !s.hidden);
  const hidden = all.filter((s) => s.hidden);
  if (!shown.length)
    return `${emptyHtml('No skills yet', 'Skills teach the agent a workflow (PDFs, slides, your deploy steps). Find some in the gallery.', '<button class="primary" data-sk-browse>Browse the gallery</button>')}${hiddenHtml(hidden, view)}`;
  const on = shown.filter((s) => s.enabled);
  const total = on.reduce((n, s) => n + s.tokens, 0);
  return `<p class="hint">${String(on.length)} of ${String(shown.length)} on · ~${formatTokens(total)} tokens per request (the full skill loads only when used)</p><ul class="sk-list">${shown.map((s) => rowHtml(s, view)).join('')}</ul>${hiddenHtml(hidden, view)}`;
}
