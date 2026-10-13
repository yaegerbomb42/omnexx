/**
 * The settings page inside the chat panel (the gear): the chat model, connected providers, a form
 * to add one, the approval default, and advanced links. Data comes from `omnexx chat-server`
 * (`settings`, `models`) through the extension; keys arrive masked and are sent once, on save.
 */
import * as modelPicker from './modelPicker.js';
import * as roles from './roles.js';
import { badge } from './modelPicker.js';
import { escapeHtml } from './render.js';

export interface CatalogProvider {
  name: string;
  label: string;
  baseUrl: string;
  local: boolean;
  signup?: string;
  keyPrefix?: string;
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

type Post = (msg: Record<string, unknown>) => void;

const CUSTOM = '__custom';

/** The provider picked in the add form (a catalog name or CUSTOM). */
let chosen = 'anthropic';
/** Filter text for the provider tiles. */
let tileQuery = '';

let catalog: CatalogProvider[] = [];
let connected: ConnectedProvider[] = [];
let current: string | null = null;
let autoApproveDefault = false;
let confirmingRemove: string | undefined;
/** Provider checks: running, or what the last one found. */
let tests: Record<string, 'running' | { ok: boolean; detail: string }> = {};
/** Whether this opening of the page has checked every provider yet. */
let testedOnOpen = false;
let saving = false;
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
  if (!connected.length)
    return '<p class="hint">Nothing connected yet. Add a provider below to start chatting.</p>';
  return `<ul class="providers">${connected
    .map((p) => {
      const key = p.local
        ? '<span class="pill local">local</span>'
        : p.key
          ? `<span class="pill ok">key ${escapeHtml(p.key)}</span>${p.keySource && p.keySource !== 'credentials file' ? `<span class="pill">from ${escapeHtml(p.keySource)}</span>` : ''}`
          : '<span class="pill warn">no key</span>';
      const result = tests[p.name];
      const check =
        result === 'running'
          ? '<span class="pill busy">checking…</span>'
          : result
            ? `<span class="pill ${result.ok ? 'ok' : 'warn'}">${result.ok ? '✓' : '✗'} ${escapeHtml(result.detail)}</span>`
            : '';
      const remove =
        confirmingRemove === p.name
          ? `<button class="danger-btn" data-remove-confirm="${escapeHtml(p.name)}">Remove</button><button class="ghost" data-remove-cancel>Cancel</button>`
          : `<button class="ghost" data-remove="${escapeHtml(p.name)}" title="Remove ${escapeHtml(p.label)} and its stored key">Remove</button>`;
      return `<li class="provider"><div class="p-main"><div class="p-name">${escapeHtml(p.label)}</div><div class="p-url">${escapeHtml(p.baseUrl)}</div><div class="p-tags">${key}${check}</div></div><div class="p-actions"><button class="ghost" data-test="${escapeHtml(p.name)}" title="Check that omnexx can reach it">Test</button>${remove}</div></li>`;
    })
    .join('')}</ul>`;
}

function tilesHtml(): string {
  const words = tileQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const fits = (c: CatalogProvider): boolean =>
    words.every((w) => `${c.name} ${c.label}`.toLowerCase().includes(w));
  const tile = (name: string, label: string, sub: string): string =>
    `<button class="ptile${chosen === name ? ' on' : ''}" data-provider="${escapeHtml(name)}" aria-pressed="${String(chosen === name)}" title="${escapeHtml(label)}">${badge(name === CUSTOM ? 'url' : name)}<span class="t-label">${escapeHtml(label.replace(/\s*\(.*\)$/, ''))}</span><span class="t-sub">${escapeHtml(sub)}</span></button>`;
  const hosted = catalog.filter((c) => !c.local && fits(c));
  const local = catalog.filter((c) => c.local && fits(c));
  const custom = words.length === 0 || 'custom url openai compatible'.includes(words.join(' '));
  return `${hosted.length ? `<div class="t-group">Hosted</div><div class="tiles">${hosted.map((c) => tile(c.name, c.label, c.keyPrefix ? `${c.keyPrefix}…` : 'API key')).join('')}</div>` : ''}${local.length ? `<div class="t-group">On your machine</div><div class="tiles">${local.map((c) => tile(c.name, c.label, 'no key')).join('')}</div>` : ''}${custom ? `<div class="t-group">Other</div><div class="tiles">${tile(CUSTOM, 'Custom URL', 'OpenAI-compatible')}</div>` : ''}${!hosted.length && !local.length && !custom ? '<p class="hint">No provider matches.</p>' : ''}`;
}

function draw(): void {
  const page = q('settings', HTMLElement);
  page.innerHTML = `
<div class="set-head"><button class="ghost back" data-settings-close>← Back to chat</button><h2>Settings</h2></div>
<section class="set-section"><h3>Chat model</h3>${modelFieldHtml()}</section>
<section class="set-section"><h3>Who does what</h3><div id="roles-box">${roles.html()}</div></section>
<section class="set-section"><h3>Providers</h3>${connectedHtml()}</section>
<section class="set-section add"><h3>Add a provider</h3>
  <input id="tile-search" class="field" type="search" placeholder="Search 30+ providers…" aria-label="Search providers" value="${escapeHtml(tileQuery)}" spellcheck="false">
  <div id="tile-box" class="tile-box">${tilesHtml()}</div>
  <div id="add-url-row"><label for="add-url">Base URL</label><input id="add-url" class="field" type="url" placeholder="http://localhost:8000/v1" spellcheck="false"></div>
  <div id="add-name-row"><label for="add-name">Name</label><input id="add-name" class="field" type="text" placeholder="mybox" spellcheck="false"></div>
  <div id="add-key-row"><label for="add-key">API key</label><input id="add-key" class="field" type="password" autocomplete="off" spellcheck="false"><a id="add-signup" class="signup" href="#">Get a key ↗</a></div>
  <p class="hint">Keys are stored in a private file on this machine (0600) and only ever shown masked.</p>
  <div class="row-end"><span id="add-status" class="status" role="status"></span><button id="add-save" class="primary">Connect</button></div>
</section>
<section class="set-section"><h3>Approvals</h3>
  <div class="seg wide" role="group" aria-label="Approval default">
    <button data-approval-default="ask" aria-pressed="${String(!autoApproveDefault)}">Ask first</button>
    <button data-approval-default="auto" aria-pressed="${String(autoApproveDefault)}">Auto-approve</button>
  </div>
  <p class="hint">How new chats start. Auto-approve lets omnexx go outside the repo and run guarded commands without asking; hard-blocked commands stay blocked.</p>
</section>
<section class="set-section"><h3>Advanced</h3>
  <div class="links">
    <button class="ghost" data-action-ext="editToml">Edit project settings (omnexx.toml)</button>
    <button class="ghost" data-action-ext="editUserConfig">Edit user settings (config.toml)</button>
    <button class="ghost" data-action-ext="restart">Restart omnexx</button>
  </div>
</section>`;
  syncForm();
  drawStatus();
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
  saving = true;
  status = { text: 'Connecting and listing models…', kind: 'busy' };
  drawStatus();
  post({
    type: 'addProvider',
    ...(custom ? { url, ...(name ? { provider: name } : {}) } : { provider: p?.name }),
    ...(p?.local ? { url } : {}),
    ...(key ? { key } : {}),
  });
  q('add-key', HTMLInputElement).value = '';
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

export function open(post: Post): void {
  testedOnOpen = false;
  document.body.classList.add('settings-open');
  q('settings', HTMLElement).hidden = false;
  draw();
  post({ type: 'settings' });
  post({ type: 'models' });
  roles.request(post);
}

export function close(): void {
  document.body.classList.remove('settings-open');
  q('settings', HTMLElement).hidden = true;
}

/** Messages from the extension that belong to the settings page; true when handled. */
export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (roles.onMessage(m)) return true;
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
  } else if (m.type === 'prefs') {
    autoApproveDefault = m.autoApproveDefault === true;
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
  const page = q('settings', HTMLElement);
  page.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (roles.click(t, post)) return;
    const tileName = t.closest<HTMLElement>('[data-provider]')?.dataset.provider;
    if (tileName) {
      chosen = tileName;
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
        draw();
      } else if (ext) post({ type: ext });
    }
  });
  page.addEventListener('input', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.id === 'tile-search') {
      tileQuery = e.target.value;
      q('tile-box', HTMLElement).innerHTML = tilesHtml();
      return;
    }
    if (e.target instanceof Element && e.target.closest('.add')) formTouched = true;
  });
  page.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) save(post);
    if (e.key === 'Escape') close();
  });
}
