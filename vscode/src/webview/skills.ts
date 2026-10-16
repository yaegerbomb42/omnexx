/**
 * Skills in settings: every skill omnexx can use (built-in folders, the repo's, your own,
 * Claude Code's, marketplace installs) with its source, an on/off switch and what its catalog
 * line costs per request; and a gallery of marketplace skills (Anthropic's skills repo plus any
 * GitHub repo you add) to search, preview (source and file list first) and install. Installing
 * copies files only; nothing in a skill is run automatically.
 */
import { escapeHtml } from './render.js';
import { flashSaved } from './savedMark.js';
import { listHtml, removeMessage, type Installed, type ListView } from './skillsList.js';

type Post = (msg: Record<string, unknown>) => void;

interface MarketSkill {
  id: string;
  name: string;
  description: string;
  repo: string;
  url: string;
  files: { path: string; size: number }[];
}

let installed: Installed[] = [];
let sources: string[] = [];
let market: MarketSkill[] | null = null;
let errors: string[] = [];
let query = '';
let searching = false;
let notice = '';
let preview: { skill: MarketSkill; text: string } | null = null;
let post: Post | undefined;
let view: ListView = { showHidden: false };

const PREVIEW_CHARS = 4_000;

function installedHtml(): string {
  return listHtml(installed, view);
}

function previewHtml(): string {
  if (!preview) return '';
  const { skill, text } = preview;
  const files = skill.files
    .map(
      (f) =>
        `<li><code>${escapeHtml(f.path)}</code> <span class="sk-tok">${String(f.size)} B</span></li>`,
    )
    .join('');
  const shown = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…` : text;
  return `<div class="sk-preview"><div class="sk-top"><span class="sk-name">${escapeHtml(skill.name)}</span><a href="#" data-sk-link="${escapeHtml(skill.url)}">${escapeHtml(skill.repo)} ↗</a></div>
<p class="hint">Files that will be copied (nothing is run):</p><ul class="sk-files">${files}</ul>
<pre class="ci-text">${escapeHtml(shown)}</pre>
<div class="ci-actions"><button class="primary small" data-sk-install="${escapeHtml(skill.id)}">Install and enable</button><button class="ghost small" data-sk-close>Close</button></div></div>`;
}

function marketHtml(): string {
  const err = errors
    .map((e) => `<p class="hint warn">Could not read ${escapeHtml(e)}</p>`)
    .join('');
  if (searching) return `${err}<p class="hint"><span class="spinner"></span> Searching…</p>`;
  if (!market) return `${err}<p class="hint">Search, or press Enter to browse everything.</p>`;
  if (!market.length) return `${err}<p class="hint">No skills match.</p>`;
  const have = new Set(installed.map((s) => s.from).filter(Boolean));
  const rows = market
    .slice(0, 60)
    .map(
      (s) =>
        `<li class="sk"><div class="sk-main"><div class="sk-top"><span class="sk-name">${escapeHtml(s.name)}</span><span class="sk-badge">${escapeHtml(s.repo)}</span></div><div class="sk-about">${escapeHtml(s.description)}</div></div><button class="ghost small" data-sk-preview="${escapeHtml(s.id)}">${have.has(s.id) ? 'Installed' : 'Preview'}</button></li>`,
    )
    .join('');
  return `${err}<ul class="sk-list">${rows}</ul>`;
}

export function html(): string {
  return `<div id="sk-installed">${installedHtml()}</div>
<div class="ci-actions"><button class="ghost small" data-sk-update>Check for updates</button></div>
<h4>Gallery</h4>
<input id="sk-search" class="field" type="search" placeholder="Search skills in ${escapeHtml(sources.join(', ') || 'marketplaces')}" aria-label="Search skills" value="${escapeHtml(query)}" spellcheck="false">
${previewHtml()}<div id="sk-market">${marketHtml()}</div>
<div class="sk-add"><input id="sk-source" class="field" type="text" placeholder="Add a marketplace: owner/repo or GitHub URL" spellcheck="false"><button class="ghost small" data-sk-market-add>Add</button></div>
${notice ? `<p class="hint" role="status">${escapeHtml(notice)}</p>` : ''}`;
}

function redraw(): void {
  const box = document.getElementById('skills-box');
  if (!box) return;
  const focused = document.activeElement?.id;
  box.innerHTML = html();
  if (focused === 'sk-search') document.getElementById('sk-search')?.focus();
}

export function request(p: Post): void {
  post = p;
  p({ type: 'skills' });
}

export function search(p: Post): void {
  const field = document.getElementById('sk-search');
  query = field instanceof HTMLInputElement ? field.value : query;
  searching = true;
  preview = null;
  redraw();
  p({ type: 'skillsSearch', query });
}

function addMarket(p: Post): void {
  const field = document.getElementById('sk-source');
  const source = field instanceof HTMLInputElement ? field.value.trim() : '';
  if (!source) return;
  notice = `Reading ${source}…`;
  redraw();
  p({ type: 'skillsMarketAdd', source });
}

/** Messages for the skills section; true when handled. */
export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type === 'skills') {
    installed = (m.installed as Installed[] | undefined) ?? [];
    sources = (m.marketplaces as string[] | undefined) ?? sources;
    notice = typeof m.notice === 'string' ? m.notice : '';
    if (notice.startsWith('installed') || notice.startsWith('added')) preview = null;
  } else if (m.type === 'skillsMarket') {
    market = (m.skills as MarketSkill[] | undefined) ?? [];
    errors = (m.errors as string[] | undefined) ?? [];
    searching = false;
  } else if (m.type === 'skillsPreview') {
    preview = { skill: m.skill as MarketSkill, text: typeof m.text === 'string' ? m.text : '' };
  } else if (m.type === 'error' && (searching || notice.endsWith('…'))) {
    searching = false;
    notice = typeof m.message === 'string' ? m.message : 'something went wrong';
    redraw();
    return false;
  } else return false;
  redraw();
  return true;
}

const data = (t: Element, key: string): string | undefined =>
  t.closest<HTMLElement>(`[data-${key}]`)?.getAttribute(`data-${key}`) ?? undefined;

/** Remove, hide, delete, bring back and the empty state's button; true when handled. */
function listClick(t: Element, p: Post): boolean {
  const remove = data(t, 'sk-remove');
  const pick = data(t, 'sk-hide') ?? data(t, 'sk-delete');
  const unhide = data(t, 'sk-unhide');
  if (remove) view = { ...view, confirming: view.confirming === remove ? undefined : remove };
  else if (t.closest('[data-sk-remove-cancel]')) view = { ...view, confirming: undefined };
  else if (pick) {
    const s = installed.find((x) => x.name === pick);
    view = { ...view, confirming: undefined };
    if (s) p(removeMessage(s, t.closest('[data-sk-hide]') ? 'hide' : 'delete'));
  } else if (unhide) p({ type: 'skillsUnhide', name: unhide });
  else if (t.closest('[data-sk-show-hidden]')) view = { ...view, showHidden: !view.showHidden };
  else if (t.closest('[data-sk-browse]')) {
    search(p);
    document.getElementById('sk-search')?.focus();
    return true;
  } else return false;
  redraw();
  return true;
}

/** Clicks inside the skills box; true when handled. */
export function click(t: Element, p: Post): boolean {
  if (!t.closest('#skills-box')) return false;
  const toggle = t instanceof HTMLInputElement ? t.dataset.skToggle : undefined;
  const open = data(t, 'sk-open');
  const show = data(t, 'sk-preview');
  const install = data(t, 'sk-install');
  const link = data(t, 'sk-link');
  if (toggle && t instanceof HTMLInputElement) {
    p({ type: 'skillsToggle', name: toggle, on: t.checked });
    flashSaved('skills');
  } else if (open) p({ type: 'open', path: open });
  else if (listClick(t, p)) return true;
  else if (show) p({ type: 'skillsPreview', id: show });
  else if (install) {
    notice = 'Installing…';
    redraw();
    p({ type: 'skillsInstall', id: install });
  } else if (link) p({ type: 'openExternal', url: link });
  else if (t.closest('[data-sk-close]')) {
    preview = null;
    redraw();
  } else if (t.closest('[data-sk-update]')) {
    notice = 'Checking for updates…';
    redraw();
    p({ type: 'skillsUpdate' });
  } else if (t.closest('[data-sk-market-add]')) addMarket(p);
  else return false;
  return true;
}

/** Enter in the search or marketplace field; true when handled. */
export function enter(t: HTMLInputElement): boolean {
  if (!post || !t.closest('#skills-box')) return false;
  if (t.id === 'sk-search') search(post);
  else if (t.id === 'sk-source') addMarket(post);
  return true;
}
