/**
 * The tabbed settings page inside the chat panel (the gear): providers and models, the agent,
 * tools, appearance and advanced links. Data comes from `omnexx chat-server` (`settings`,
 * `models`) through the extension; keys arrive masked and are sent once, on save.
 */
import * as modelPicker from './modelPicker.js';
import * as roles from './roles.js';
import * as mcp from './mcp.js';
import * as skills from './skills.js';
import * as agentCard from './agentCard.js';
import * as posture from './posture.js';
import * as domain from './domain.js';
import * as stats from './stats.js';
import { badge, providerHue } from './modelPicker.js';
import { emptyStateHtml } from './emptyState.js';
import { escapeHtml } from './render.js';
import * as providerForm from './providerForm.js';
import * as layout from './settingsLayout.js';
import { flashSaved } from './savedMark.js';
import type { SectionId, TabId } from './settingsLayout.js';

export interface CatalogProvider {
  name: string;
  label: string;
  baseUrl: string;
  local: boolean;
  signup?: string;
  keyPrefix?: string;
  fields?: providerForm.CatalogField[];
  note?: string;
  docs?: string;
  freeTier?: boolean;
}

export interface ConnectedProvider {
  name: string;
  label: string;
  baseUrl: string;
  local: boolean;
  free: boolean;
  key: string | null;
  keySource: string | null;
}

interface BrowserPrefs {
  engine: 'chromium' | 'camoufox';
  profile: string | null;
  sessionName: string | null;
  headless: boolean;
}

type Post = (msg: Record<string, unknown>) => void;

const CUSTOM = '__custom';

/** The provider picked in the add form (a catalog name or CUSTOM). */
let chosen = 'anthropic';
/** Filter text for the provider tiles. */
let tileQuery = '';
/** The add form's provider list starts short; this opens the rest. */
let showAllProviders = false;

let catalog: CatalogProvider[] = [];
let connected: ConnectedProvider[] = [];
let current: string | null = null;
let autoApproveDefault = false;
let lazyToolDiscovery = true;
let confirmingRemove: string | undefined;
/** Provider checks: running, or what the last one found. */
let tests: Record<string, 'running' | { ok: boolean; detail: string }> = {};
/** Whether this opening of the page has checked every provider yet. */
let testedOnOpen = false;
let saving = false;
/** The agent's browser settings from config, or undefined until they arrive. */
let browserPrefs: BrowserPrefs | undefined;
let engineInfo: { source: string; version: string | null; bundled: string } | undefined;

const ENGINE_LABEL: Record<string, string> = {
  bundled: 'the copy built into this extension',
  global: 'your installed omnexx',
  setting: 'the omnexx.path setting',
};

function engineHtml(): string {
  if (!engineInfo) return '<p class="hint">Checking which omnexx runs this panel…</p>';
  const label = ENGINE_LABEL[engineInfo.source];
  const what = label ? `${label} (${escapeHtml(engineInfo.version ?? '?')})` : 'nothing yet';
  const install =
    engineInfo.source === 'bundled' || engineInfo.source === 'missing'
      ? '<button class="ghost" data-action-ext="installCli">Install omnexx for your terminal</button>'
      : '';
  return `<p class="hint">Engine: ${what}.</p>${install}`;
}
function browserHtml(): string {
  if (!browserPrefs) return '<p class="hint">Loading browser settings…</p>';
  const b = browserPrefs;
  const pressed = (on: boolean): string => `aria-pressed="${String(on)}"`;
  return `<label>Engine</label>
  <div class="seg wide" role="group" aria-label="Browser engine">
    <button data-browser-engine="chromium" ${pressed(b.engine === 'chromium')}>Chromium</button>
    <button data-browser-engine="camoufox" ${pressed(b.engine === 'camoufox')}>Camoufox</button>
  </div>
  ${b.engine === 'camoufox' ? '<p class="hint">Needs: npm i -g playwright-core camoufox-js &amp;&amp; npx camoufox-js fetch</p>' : ''}
  <label>Window</label>
  <div class="seg wide" role="group" aria-label="Headless">
    <button data-browser-headless="on" ${pressed(b.headless)}>Headless</button>
    <button data-browser-headless="off" ${pressed(!b.headless)}>Show window</button>
  </div>
  <label for="browser-profile">Profile folder</label>
  <input id="browser-profile" class="field" type="text" placeholder="optional: reuse its logins" spellcheck="false" value="${escapeHtml(b.profile ?? '')}">
  <label for="browser-session">Session name</label>
  <input id="browser-session" class="field" type="text" placeholder="optional" spellcheck="false" value="${escapeHtml(b.sessionName ?? '')}">
  <p class="hint">New runs use these.</p>`;
}

/** Save the browser settings with one change applied, reading the text fields as they stand. */
function saveBrowser(post: Post, change: Partial<BrowserPrefs>): void {
  if (!browserPrefs) return;
  const text = (id: string): string => {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement ? el.value.trim() : '';
  };
  const profile = text('browser-profile');
  const sessionName = text('browser-session');
  browserPrefs = {
    ...browserPrefs,
    profile: profile || null,
    sessionName: sessionName || null,
    ...change,
  };
  post({
    type: 'setBrowser',
    engine: browserPrefs.engine,
    headless: browserPrefs.headless,
    ...(browserPrefs.profile ? { profile: browserPrefs.profile } : {}),
    ...(browserPrefs.sessionName ? { sessionName: browserPrefs.sessionName } : {}),
  });
  flashSaved('browser');
}

/** The person has typed or picked something in the add form, so a redraw keeps it. */
let formTouched = false;
let status: { text: string; kind: 'ok' | 'error' | 'busy' } | undefined;

function q<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`missing #${id}`);
  return found;
}

function modelFieldHtml(): string {
  if (!current)
    return '<button id="set-model-btn" class="field picker" data-open-model-picker><span class="muted">Pick a model</span><span class="caret">▾</span></button>';
  const [provider = '', ...rest] = current.split(':');
  return `<button id="set-model-btn" class="field picker" data-open-model-picker>${badge(provider)}<span class="pk-name">${escapeHtml(rest.join(':') || current)}</span><span class="pk-sub">${escapeHtml(provider)}</span><span class="caret">▾</span></button>`;
}

function connectedHtml(): string {
  if (!connected.length) return emptyStateHtml();
  return `<ul class="providers">${connected
    .map((p) => {
      const result = tests[p.name];
      const state = result === 'running' ? 'busy' : result ? (result.ok ? 'ok' : 'bad') : 'idle';
      const dotTitle =
        state === 'ok'
          ? 'Tested OK'
          : state === 'bad'
            ? 'Test failed'
            : state === 'busy'
              ? 'Checking…'
              : p.local || p.key
                ? 'Not tested yet'
                : 'Needs a key';
      const key = p.local
        ? '<span class="pill local">local</span>'
        : p.key
          ? `<span class="pill ok">key ${escapeHtml(p.key)}</span>${p.keySource && p.keySource !== 'credentials file' ? `<span class="pill">from ${escapeHtml(p.keySource)}</span>` : ''}`
          : '<span class="pill warn">no key</span>';
      const check =
        result === 'running'
          ? '<span class="pill busy pulse">checking…</span>'
          : result
            ? `<span class="pill ${result.ok ? 'ok' : 'warn'}">${result.ok ? '✓' : '✗'} ${escapeHtml(result.detail)}</span>`
            : '';
      const remove =
        confirmingRemove === p.name
          ? `<button class="danger-btn" data-remove-confirm="${escapeHtml(p.name)}">Remove</button><button class="ghost" data-remove-cancel>Cancel</button>`
          : `<button class="ghost" data-remove="${escapeHtml(p.name)}" title="Remove ${escapeHtml(p.label)} and its stored key">Remove</button>`;
      return `<li class="provider" data-state="${state}" style="--h:${String(providerHue(p.name))}"><span class="p-dot${state === 'busy' ? ' pulse' : ''}" role="img" aria-label="${escapeHtml(dotTitle)}" title="${escapeHtml(dotTitle)}"></span><div class="p-main"><div class="p-name">${escapeHtml(p.label)}</div><div class="p-url" title="${escapeHtml(p.baseUrl)}">${escapeHtml(p.baseUrl)}</div><div class="p-tags">${key}${check}</div></div><div class="p-actions"><button class="ghost" data-test="${escapeHtml(p.name)}" title="Check that omnexx can reach it">Test</button>${remove}</div></li>`;
    })
    .join('')}</ul>`;
}

function tilesHtml(): string {
  const words = tileQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const fits = (c: CatalogProvider): boolean =>
    words.every((w) => `${c.name} ${c.label}`.toLowerCase().includes(w));
  const tile = (name: string, label: string, sub: string): string =>
    `<button class="ptile${chosen === name ? ' on' : ''}" data-provider="${escapeHtml(name)}" aria-pressed="${String(chosen === name)}" title="${escapeHtml(label)}" style="--h:${String(providerHue(name === CUSTOM ? 'url' : name))}">${badge(name === CUSTOM ? 'url' : name)}<span class="t-label">${escapeHtml(label.replace(/\s*\(.*\)$/, ''))}</span><span class="t-sub">${escapeHtml(sub)}</span>${chosen === name ? '<span class="t-check" aria-hidden="true">✓</span>' : ''}</button>`;
  const hostedAll = catalog.filter((c) => !c.local && fits(c));
  const searchable = words.length > 0;
  const hosted = searchable || showAllProviders ? hostedAll : hostedAll.slice(0, 8);
  const local = catalog.filter((c) => c.local && fits(c));
  const custom =
    words.length === 0 ||
    words.every((w) => 'custom url openai anthropic compatible endpoint proxy'.includes(w));
  const more =
    !searchable && hostedAll.length > 8
      ? `<button class="t-show-all ghost small" data-show-all>${showAllProviders ? 'Show less' : `Show all (${String(hostedAll.length)})`}</button>`
      : '';
  return `${hosted.length ? `<div class="t-group">Hosted</div><div class="tiles">${hosted.map((c) => tile(c.name, c.label, c.fields?.length ? 'needs setup' : c.freeTier ? 'free tier' : c.keyPrefix ? `${c.keyPrefix}…` : 'API key')).join('')}</div>${more}` : ''}${local.length ? `<div class="t-group">On your machine</div><div class="tiles">${local.map((c) => tile(c.name, c.label, 'no key')).join('')}</div>` : ''}${custom ? `<div class="t-group">Other</div><div class="tiles">${tile(CUSTOM, 'Custom endpoint', 'OpenAI / Anthropic API')}</div>` : ''}${!hosted.length && !local.length && !custom ? '<p class="hint">No provider matches.</p>' : ''}`;
}

/**
 * Where the folded sections and the open tab are remembered (the webview's state; tests and
 * first run: memory). `getTab`/`setTab` are optional so an older store still works.
 */
export interface FoldStore {
  get: () => unknown;
  set: (folded: SectionId[]) => void;
  getTab?: () => unknown;
  setTab?: (tab: TabId) => void;
}

let folded: SectionId[] = [...layout.FOLDED_BY_DEFAULT];
let foldStore: FoldStore | undefined;
let tab: TabId = layout.TABS[0]?.id ?? 'providers';

/** Use the webview's saved state for which sections are folded and which tab is open. */
export function useFoldStore(store: FoldStore): void {
  foldStore = store;
  const saved = store.get();
  if (Array.isArray(saved)) folded = saved.filter(layout.isSectionId);
  const savedTab = store.getTab?.();
  if (layout.isTabId(savedTab)) tab = savedTab;
}

/** One animation token per section body, so a fast re-toggle never lets a stale
 *  transitionend/timeout finish a newer animation. */
const foldTokens = new WeakMap<HTMLElement, number>();

function setFolded(id: SectionId, fold: boolean): void {
  folded = layout.toggled(folded, id, fold);
  foldStore?.set(folded);
  const section = document.getElementById(`sec-${id}`);
  section?.classList.toggle('folded', fold);
  section?.querySelector('.sec-head')?.setAttribute('aria-expanded', String(!fold));
  const body = document.getElementById(`sec-body-${id}`);
  if (!body) return;
  // Reduced motion: instant, as before.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    body.hidden = fold;
    return;
  }
  const token = (foldTokens.get(body) ?? 0) + 1;
  foldTokens.set(body, token);
  const done = (): void => {
    if (foldTokens.get(body) !== token) return;
    if (fold) body.hidden = true;
    body.style.transition = '';
    body.style.height = '';
    body.style.overflow = '';
  };
  body.style.overflow = 'hidden';
  if (fold) {
    body.style.height = `${String(body.scrollHeight)}px`;
    requestAnimationFrame(() => {
      if (foldTokens.get(body) !== token) return;
      body.style.transition = 'height 0.25s ease';
      body.style.height = '0px';
    });
  } else {
    body.hidden = false;
    body.style.height = '0px';
    requestAnimationFrame(() => {
      if (foldTokens.get(body) !== token) return;
      body.style.transition = 'height 0.25s ease';
      body.style.height = `${String(body.scrollHeight)}px`;
    });
  }
  body.addEventListener('transitionend', done, { once: true });
  // Fallback: a cancelled transition still settles.
  setTimeout(done, 300);
}

/** Paint the tab state already in `tab` without writing it back to the store. */
function paintTab(focus = false): void {
  document.querySelectorAll<HTMLElement>('[role="tab"][data-settings-tab]').forEach((el) => {
    const active = el.dataset.settingsTab === tab;
    el.classList.toggle('on', active);
    el.setAttribute('aria-selected', String(active));
    el.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach((el) => {
    const active = el.dataset.settingsPanel === tab;
    el.classList.toggle('active', active);
    el.hidden = !active;
  });
  if (focus) document.getElementById(`set-tab-${tab}`)?.focus();
}

/** Switch tabs, remember the choice, and optionally move keyboard focus to the new tab. */
function selectTab(id: TabId, focus = false): void {
  tab = id;
  foldStore?.setTab?.(id);
  paintTab(focus);
}

/** A nav chip: switch to its tab, unfold its section and bring it into view. */
function jumpTo(id: SectionId): void {
  selectTab(layout.tabForSection(id));
  setFolded(id, false);
  document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let spy: IntersectionObserver | undefined;

/** Scroll-spy: mark the nav chip for the section currently in view. Re-armed after
 *  every redraw (draw() replaces the section elements). Inert when no chip nav is
 *  rendered — the tabbed page shows its position through the tab bar instead. */
function armScrollSpy(): void {
  spy?.disconnect();
  if (!('IntersectionObserver' in window)) return;
  const page = document.getElementById('settings');
  if (!page?.querySelector('[data-sec-jump]')) return;
  spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = (e.target as HTMLElement).dataset.sec;
        if (!id) continue;
        for (const c of page.querySelectorAll<HTMLElement>('[data-sec-jump]'))
          c.classList.toggle('on', c.dataset.secJump === id);
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  );
  for (const s of page.querySelectorAll<HTMLElement>('[data-sec]')) spy.observe(s);
}

const sec = (id: SectionId, body: string, extra = ''): string =>
  layout.sectionHtml(id, body, folded.includes(id), extra);

function addFormHtml(): string {
  return `<input id="tile-search" class="field" type="search" placeholder="Search ${String(catalog.length || 30)}+ providers…" aria-label="Search providers" value="${escapeHtml(tileQuery)}" spellcheck="false">
  <div id="tile-box" class="tile-box">${tilesHtml()}</div>
  <div id="add-url-row"><label for="add-url">Base URL</label><input id="add-url" class="field" type="url" placeholder="http://localhost:8000/v1" spellcheck="false"></div>
  <div id="add-name-row"><label for="add-name">Name</label><input id="add-name" class="field" type="text" placeholder="mybox" spellcheck="false"></div>
  <div id="add-extra"></div>
  <div id="add-key-row"><label for="add-key">API key</label><input id="add-key" class="field" type="password" autocomplete="off" spellcheck="false"><a id="add-signup" class="signup" href="#">Get a key ↗</a></div>
  <p class="hint">🔒 Stored privately on this machine; only ever shown masked.</p>
  <div class="row-end"><span id="add-status" class="status" role="status"></span><button id="add-probe" class="ghost" title="Check the URL and key without saving">Test</button><button id="add-save" class="primary">Connect</button></div>`;
}

function approvalsHtml(): string {
  return `<div class="seg wide" role="group" aria-label="Approval default">
    <button data-approval-default="ask" aria-pressed="${String(!autoApproveDefault)}">Ask first</button>
    <button data-approval-default="auto" aria-pressed="${String(autoApproveDefault)}">Auto-approve</button>
  </div>
  <p class="hint">${autoApproveDefault ? 'New chats run guarded commands and leave the repo without asking. Hard-blocked commands stay blocked.' : 'New chats ask before running guarded commands or touching files outside the repo.'}</p>`;
}

function advancedHtml(): string {
  return `<div class="advanced-modes"><div class="posture-title">Experimental modes</div>
<p class="hint">Work mode and execution posture live in the Agent tab, out of the way: they only appear in the chat header when experimental mode is on (<code>--experimental</code>, or <code>experimental = true</code> in config.toml).</p>
<button class="ghost small" data-goto-tab="agent">Open work modes</button></div>
<div id="engine-box" class="engine">${engineHtml()}</div>
  <div class="links">
    <button class="ghost" data-action-ext="editToml">Edit project settings (omnexx.toml)</button>
    <button class="ghost" data-action-ext="editUserConfig">Edit user settings (config.toml)</button>
    <button class="ghost" data-action-ext="restart">Restart omnexx</button>
  </div>`;
}

function workModesHtml(): string {
  return `<p class="hint">Experimental mode only adds these to the chat header.</p>${posture.cardHtml()}${domain.cardHtml()}`;
}

function appearanceHtml(): string {
  return `<p class="hint">omnexx follows your VS Code color theme, including high-contrast themes. There are no separate display preferences to set here.</p>
<p class="hint">The chat header and this page use theme variables, so contrast, fonts, and zoom stay consistent with the rest of the editor.</p>`;
}

function toolDiscoveryHtml(): string {
  return `<section class="set-section" id="sec-discovery" aria-labelledby="sec-discovery-title">
<div class="sec-head static"><span class="sec-titles"><span class="sec-title" id="sec-discovery-title">Lazy tool discovery</span><span class="sec-sub">Send a compact tool index and load full tool definitions only when needed. Saves tokens.</span></span></div>
<div class="sec-body" id="sec-body-discovery"><div class="placeholder-row"><span class="hint">${lazyToolDiscovery ? 'On (default): tools load on demand.' : 'Off: every tool definition is sent with each request.'} Changing it restarts omnexx.</span><label class="soon-switch live" title="Lazy tool discovery"><input type="checkbox" role="switch" aria-label="Lazy tool discovery" data-lazy-tools ${lazyToolDiscovery ? 'checked' : ''}><span aria-hidden="true"></span></label></div></div>
</section>`;
}

function shortcutsHtml(): string {
  const rows: [string, string][] = [
    ['Ctrl+Alt+O / Cmd+Alt+O', 'Open Chat (focus)'],
    ['Ctrl+Alt+H / Cmd+Alt+H', 'Show History'],
    ['Ctrl+Shift+Alt+P / Cmd+Shift+Alt+P', 'Pause Run'],
    ['Ctrl+Shift+Alt+R / Cmd+Shift+Alt+R', 'Resume Run'],
    ['Ctrl+Shift+Alt+S / Cmd+Shift+Alt+S', 'Stop Run'],
    ['Ctrl+Shift+Alt+N / Cmd+Shift+Alt+N', 'New Chat'],
    ['Ctrl+Shift+Alt+Z / Cmd+Shift+Alt+Z', 'Undo Last Message\u2019s Edits'],
    ['Ctrl+Shift+Alt+M / Cmd+Shift+Alt+M', 'Pick Chat Model'],
  ];
  // Each key gets its own <kbd> (alternatives separated by ' / '), so the
  // stylesheet can render real key caps instead of one flat string.
  const kbd = (combo: string): string =>
    combo
      .split(' / ')
      .map((alt) =>
        alt
          .split('+')
          .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
          .join('+'),
      )
      .join(' / ');
  return `<table class="shortcuts"><thead><tr><th>Keybinding</th><th>Action</th></tr></thead><tbody>${rows
    .map(
      ([key, action]) => `<tr><td class="key">${kbd(key)}</td><td>${escapeHtml(action)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function draw(): void {
  const page = q('settings', HTMLElement);
  const panel = (id: TabId, body: string): string => layout.tabPanelHtml(id, body, tab === id);
  page.innerHTML = `
<div class="set-top">
  <div class="set-head"><button class="ghost back nav-pill" data-settings-close>← Back to chat</button><h2>Settings</h2></div>
  ${layout.tabsHtml(tab, { providers: connected.length })}
</div>
<div class="set-panels">
${panel(
  'providers',
  `${sec('model', modelFieldHtml())}
${sec('providers', connectedHtml())}
${sec('add', addFormHtml(), 'add')}`,
)}
${panel(
  'agent',
  `${sec('agent', `<div id="agent-box">${agentCard.html()}</div><div id="token-budget">${stats.tokenBudgetHtml()}</div><div id="live-stats">${stats.liveStatsHtml()}</div>`)}
${sec('models', `<div id="roles-box">${roles.html()}</div>`)}
${sec('approvals', approvalsHtml())}
${layout.cardHtml('Work modes', 'How much autonomy a run has and what kind of work it does.', workModesHtml())}`,
)}
${panel(
  'tools',
  `${sec('mcp', `<div id="mcp-box">${mcp.html()}</div>`)}
${sec('skills', `<div id="skills-box">${skills.html()}</div>`)}
${sec('browser', `<div id="browser-box">${browserHtml()}</div>`)}
${toolDiscoveryHtml()}`,
)}
${panel(
  'appearance',
  `${layout.cardHtml('Theme', 'omnexx follows your VS Code color theme, including high contrast.', appearanceHtml())}
${sec('shortcuts', shortcutsHtml())}`,
)}
${panel('advanced', sec('advanced', advancedHtml()))}
</div>`;
  paintTab();
  posture.render();
  domain.render();
  stats.refresh();
  syncForm();
  drawStatus();
  armScrollSpy();
}

function selectedProvider(): CatalogProvider | undefined {
  const value = chosen;
  return catalog.find((c) => c.name === value);
}

/** Show the fields the chosen provider needs: a key for hosted ones, a URL for local and custom. */
function syncForm(): void {
  const custom = chosen === CUSTOM;
  const p = selectedProvider();
  q('add-url-row', HTMLElement).hidden = !custom && !p?.local;
  q('add-name-row', HTMLElement).hidden = !custom;
  q('add-key-row', HTMLElement).hidden = Boolean(p?.local);
  const url = q('add-url', HTMLInputElement);
  if (p?.local) url.value = p.baseUrl;
  else if (!custom) url.value = '';
  const key = q('add-key', HTMLInputElement);
  key.placeholder = p?.keyPrefix ? `${p.keyPrefix}…` : custom ? 'optional' : 'paste your key';
  q('add-extra', HTMLElement).innerHTML = providerForm.extrasHtml(p, custom);
  const signup = q('add-signup', HTMLAnchorElement);
  signup.hidden = !p?.signup;
  signup.href = p?.signup ?? '#';
}

function drawStatus(): void {
  const node = document.getElementById('add-status');
  if (!node) return;
  node.textContent = status?.text ?? '';
  node.className = `status ${status?.kind ?? ''}`;
  const save = document.getElementById('add-save');
  if (save instanceof HTMLButtonElement) {
    save.disabled = saving;
    save.textContent = saving ? 'Connecting…' : 'Connect';
  }
}

function save(post: Post): void {
  const custom = chosen === CUSTOM;
  const p = selectedProvider();
  const key = q('add-key', HTMLInputElement).value.trim();
  const url = q('add-url', HTMLInputElement).value.trim();
  const name = q('add-name', HTMLInputElement).value.trim().toLowerCase();
  if (custom && !/^https?:\/\/\S+$/i.test(url)) {
    status = { text: 'Enter the server URL, starting with http:// or https://', kind: 'error' };
    drawStatus();
    return;
  }
  if (p && !p.local && !key) {
    status = { text: `Paste your ${p.label} key first`, kind: 'error' };
    drawStatus();
    return;
  }
  const extras = providerForm.readExtras(p, custom);
  if (typeof extras === 'string') {
    status = { text: extras, kind: 'error' };
    drawStatus();
    return;
  }
  saving = true;
  status = { text: 'Connecting and listing models…', kind: 'busy' };
  drawStatus();
  post({
    type: 'addProvider',
    ...(custom ? { url, ...(name ? { provider: name } : {}) } : { provider: p?.name }),
    ...(p?.local ? { url } : {}),
    ...(key ? { key } : {}),
    ...extras,
  });
  q('add-key', HTMLInputElement).value = '';
}

function setProbeBox(html: string): void {
  const box = document.getElementById('add-probe-result');
  if (box) box.innerHTML = html;
}

/** The Test button: probe what the form holds without saving anything. */
function probe(post: Post): void {
  const custom = chosen === CUSTOM;
  const p = selectedProvider();
  const extras = providerForm.readExtras(p, custom);
  if (typeof extras === 'string') {
    status = { text: extras, kind: 'error' };
    drawStatus();
    return;
  }
  const url = q('add-url', HTMLInputElement).value.trim();
  const key = q('add-key', HTMLInputElement).value.trim();
  setProbeBox(providerForm.startProbe());
  post({
    type: 'probeProvider',
    ...(custom || p?.local ? { url } : { provider: p?.name }),
    ...(key ? { key } : {}),
    ...extras,
  });
}

export function isOpen(): boolean {
  return !q('settings', HTMLElement).hidden;
}

function testAll(post: Post): void {
  for (const p of connected) runTest(post, p.name);
}

function runTest(post: Post, name: string): void {
  tests = { ...tests, [name]: 'running' };
  post({ type: 'testProvider', name });
}

let postRef: Post | undefined;

/** Open the page, optionally unfolded and scrolled to one section (e.g. the model list). */
export function open(post: Post, section?: SectionId): void {
  testedOnOpen = false;
  document.body.classList.add('settings-open');
  q('settings', HTMLElement).hidden = false;
  draw();
  if (section)
    requestAnimationFrame(() => {
      jumpTo(section);
    });
  post({ type: 'settings' });
  post({ type: 'models' });
  post({ type: 'engineInfo' });
  post({ type: 'browser' });
  roles.request(post);
  mcp.request(post);
  skills.request(post);
  agentCard.request(post);
  posture.request(post);
  domain.request(post);
}

export function close(): void {
  document.body.classList.remove('settings-open');
  q('settings', HTMLElement).hidden = true;
}

/** Messages from the extension that belong to the settings page; true when handled. */
export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (roles.onMessage(m)) return true;
  if (mcp.onMessage(m)) return true;
  if (skills.onMessage(m)) return true;
  if (m.type === 'providerProbe') {
    setProbeBox(providerForm.onProbe(m));
    return true;
  }
  const probeError =
    m.type === 'error' && typeof m.message === 'string'
      ? providerForm.probeFailed(m.message)
      : undefined;
  if (probeError !== undefined) {
    setProbeBox(probeError);
    return true;
  }
  if (m.type === 'providerTest') {
    const name = typeof m.name === 'string' ? m.name : '';
    tests = {
      ...tests,
      [name]: { ok: m.ok === true, detail: typeof m.detail === 'string' ? m.detail : '' },
    };
  } else if (m.type === 'settings') {
    catalog = (m.catalog as CatalogProvider[] | undefined) ?? catalog;
    connected = (m.connected as ConnectedProvider[] | undefined) ?? [];
    if (!testedOnOpen && postRef) {
      testedOnOpen = true;
      testAll(postRef);
    }
    if (saving) {
      saving = false;
      formTouched = false;
      status = { text: 'Connected. Checking it now; then pick a model above.', kind: 'ok' };
      // Prove the new provider works: test every provider again, the new one included.
      if (postRef) testAll(postRef);
    }
  } else if (m.type === 'models') {
    current = typeof m.current === 'string' ? m.current : current;
  } else if (m.type === 'engine') {
    engineInfo = {
      source: typeof m.source === 'string' ? m.source : 'missing',
      version: typeof m.version === 'string' ? m.version : null,
      bundled: typeof m.bundled === 'string' ? m.bundled : '',
    };
    const box = document.getElementById('engine-box');
    if (box) box.innerHTML = engineHtml();
    return true;
  } else if (m.type === 'browser') {
    browserPrefs = {
      engine: m.engine === 'camoufox' ? 'camoufox' : 'chromium',
      profile: typeof m.profile === 'string' ? m.profile : null,
      sessionName: typeof m.sessionName === 'string' ? m.sessionName : null,
      headless: m.headless !== false,
    };
    const box = document.getElementById('browser-box');
    if (box) box.innerHTML = browserHtml();
    return true;
  } else if (m.type === 'prefs') {
    autoApproveDefault = m.autoApproveDefault === true;
    lazyToolDiscovery = m.lazyToolDiscovery !== false;
  } else if (m.type === 'error' && saving) {
    saving = false;
    status = {
      text: typeof m.message === 'string' ? m.message : 'That did not work',
      kind: 'error',
    };
    if (isOpen()) drawStatus();
    return false;
  } else return false;
  if (isOpen()) {
    // Keep what the person is typing in the add form across a redraw.
    const ids = ['add-url', 'add-name'];
    const keep = ids.map((id) => {
      const el = document.getElementById(id);
      return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : '';
    });
    draw();
    if (formTouched) {
      ids.forEach((id, i) => {
        const el = document.getElementById(id);
        const value = keep[i];
        if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && value)
          el.value = value;
      });
      syncForm();
      if (keep[0]) q('add-url', HTMLInputElement).value = keep[0];
    }
  }
  return true;
}

/** Track the model in use while the page is closed, so it opens on the right one. */
export function setCurrentModel(model: string | null): void {
  if (model === current) return;
  current = model;
  // Keep the field in step with the model actually in use while the page is open.
  const field = document.getElementById('set-model-btn');
  if (field && isOpen()) field.outerHTML = modelFieldHtml();
}

export function wire(post: Post): void {
  postRef = post;
  roles.wireDrag(q('settings', HTMLElement));
  mcp.wire(q('settings', HTMLElement), post);
  const page = q('settings', HTMLElement);
  page.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (roles.click(t, post)) return;
    if (mcp.click(t, post)) return;
    if (skills.click(t, post)) return;
    const tabId = t.closest<HTMLElement>('[data-settings-tab]')?.dataset.settingsTab;
    if (layout.isTabId(tabId)) {
      selectTab(tabId);
      return;
    }
    const gotoId = t.closest<HTMLElement>('[data-goto-tab]')?.dataset.gotoTab;
    if (layout.isTabId(gotoId)) {
      selectTab(gotoId, true);
      return;
    }
    const jump = t.closest<HTMLElement>('[data-sec-jump]')?.dataset.secJump;
    if (layout.isSectionId(jump)) {
      jumpTo(jump);
      return;
    }
    const fold = t.closest<HTMLElement>('[data-sec-toggle]')?.dataset.secToggle;
    if (layout.isSectionId(fold)) {
      setFolded(fold, !folded.includes(fold));
      return;
    }
    if (t.closest('[data-show-all]')) {
      showAllProviders = !showAllProviders;
      q('tile-box', HTMLElement).innerHTML = tilesHtml();
      return;
    }
    const tileName = t.closest<HTMLElement>('[data-provider]')?.dataset.provider;
    if (tileName) {
      chosen = tileName;
      providerForm.reset();
      formTouched = true;
      status = undefined;
      q('tile-box', HTMLElement).innerHTML = tilesHtml();
      syncForm();
      drawStatus();
      q(
        selectedProvider()?.local || chosen === CUSTOM ? 'add-url' : 'add-key',
        HTMLInputElement,
      ).focus();
      return;
    }
    const pickerBtn = t.closest<HTMLElement>('[data-open-model-picker]');
    if (pickerBtn) {
      modelPicker.open(pickerBtn, post);
      return;
    }
    if (t.closest('[data-settings-close]')) close();
    else if (t.closest('#add-save')) save(post);
    else if (t.closest('#add-probe')) probe(post);
    else if (t.closest('#add-signup')) {
      e.preventDefault();
      const href = q('add-signup', HTMLAnchorElement).href;
      if (href.startsWith('https://')) post({ type: 'openExternal', url: href });
    } else if (t.closest('[data-remove-cancel]')) {
      confirmingRemove = undefined;
      draw();
    } else {
      const test = t.closest<HTMLElement>('[data-test]')?.dataset.test;
      const ask = t.closest<HTMLElement>('[data-remove]')?.dataset.remove;
      const confirm = t.closest<HTMLElement>('[data-remove-confirm]')?.dataset.removeConfirm;
      const approval = t.closest<HTMLElement>('[data-approval-default]')?.dataset.approvalDefault;
      const ext = t.closest<HTMLElement>('[data-action-ext]')?.dataset.actionExt;
      const engine = t.closest<HTMLElement>('[data-browser-engine]')?.dataset.browserEngine;
      const headless = t.closest<HTMLElement>('[data-browser-headless]')?.dataset.browserHeadless;
      if (test) {
        runTest(post, test);
        draw();
      } else if (ask) {
        confirmingRemove = ask;
        draw();
      } else if (confirm) {
        confirmingRemove = undefined;
        post({ type: 'removeProvider', name: confirm });
      } else if (approval) {
        autoApproveDefault = approval === 'auto';
        post({ type: 'setApprovalDefault', on: autoApproveDefault });
        const box = document.getElementById('sec-body-approvals');
        if (box) box.innerHTML = approvalsHtml();
        flashSaved('approvals');
      } else if (engine === 'chromium' || engine === 'camoufox') {
        saveBrowser(post, { engine });
        q('browser-box', HTMLElement).innerHTML = browserHtml();
      } else if (headless) {
        saveBrowser(post, { headless: headless === 'on' });
        q('browser-box', HTMLElement).innerHTML = browserHtml();
      } else if (ext) post({ type: ext });
    }
  });
  page.addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.id === 'tile-search') {
      tileQuery = e.target.value;
      q('tile-box', HTMLElement).innerHTML = tilesHtml();
      return;
    }
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    )
      providerForm.remember(e.target);
    if (e.target instanceof Element && e.target.closest('.add')) formTouched = true;
  });
  // The browser text fields save when the person leaves them (or presses Enter).
  page.addEventListener('change', (e) => {
    if (e.target instanceof Element && e.target.closest('#browser-box')) saveBrowser(post, {});
    if (e.target instanceof HTMLInputElement && e.target.matches('[data-lazy-tools]')) {
      lazyToolDiscovery = e.target.checked;
      post({ type: 'setLazyToolDiscovery', on: lazyToolDiscovery });
      const sec = document.getElementById('sec-discovery');
      if (sec) sec.outerHTML = toolDiscoveryHtml();
    }
  });
  page.addEventListener('keydown', (e) => {
    const tabEl =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[role="tab"]') : null;
    const currentTab = tabEl?.dataset.settingsTab;
    if (layout.isTabId(currentTab)) {
      const next = layout.nextTabFor(currentTab, e.key);
      if (next) {
        e.preventDefault();
        selectTab(next, true);
        return;
      }
    }
    if (mcp.keydown(e, post)) return;
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      if (e.target.closest('#browser-box')) e.target.blur();
      else if (!skills.enter(e.target)) save(post);
    }
    if (e.key === 'Escape') close();
  });
}
