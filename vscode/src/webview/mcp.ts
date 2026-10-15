/**
 * The "MCP servers" section of the settings page: configured servers with a status dot, tool
 * count and context cost, an on/off switch, a tool allow-list, logs and remove; and "Add server":
 * a searchable gallery (popular servers plus the official MCP registry), a command, a URL, pasted
 * JSON, or an import from Claude / Cursor / VS Code / Windsurf. Talks to `omnexx chat-server`
 * through `{type: "mcp", op, …}` (see src/cli/chat-mcp.ts).
 */
import { escapeHtml } from './render.js';

type Post = (msg: Record<string, unknown>) => void;

interface Tool {
  name: string;
  description: string;
  tokens: number;
  allowed: boolean;
}

interface Server {
  name: string;
  origin: 'user' | 'project';
  kind: 'stdio' | 'http';
  target: string;
  enabled: boolean;
  oauth: boolean;
  allowTools: string[];
  state: 'running' | 'failed' | 'disabled' | 'unchecked';
  tools: Tool[];
  toolCount: number;
  tokens: number;
  error?: string;
}

interface Need {
  key: string;
  help?: string;
  description?: string;
  target: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

/** A gallery entry or a registry hit, as one card. */
interface Card {
  via: 'gallery' | 'registry';
  id: string;
  name: string;
  description: string;
  sub: string;
  needs: Need[];
  note?: string;
  oauth?: boolean;
  trusted?: boolean;
}

interface Importable {
  name: string;
  source: string;
  target: string;
  have: boolean;
}

type AddTab = 'gallery' | 'command' | 'url' | 'paste';

let servers: Server[] = [];
let checking = false;
let loaded = false;
let gallery: Card[] = [];
let registry: { query: string; hits: Card[]; busy: boolean } = { query: '', hits: [], busy: false };
let adding = false;
let tab: AddTab = 'gallery';
let query = '';
let picked: Card | undefined;
let importable: Importable[] | undefined;
let importChecked = new Set<string>();
/** Server whose tool list or logs are open. */
let toolsOpen: string | undefined;
let toolChoice = new Set<string>();
let logs: { name: string; text: string } | undefined;
let confirmRemove: string | undefined;
let busy: string | undefined;
let status: { text: string; ok: boolean } | undefined;
/** What the person typed, kept across redraws of the settings page. */
let typed: Record<string, string> = {};

const asText = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const val = (id: string): string => escapeHtml(typed[id] ?? '');
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function redraw(): void {
  const box = document.getElementById('mcp-box');
  if (box) box.innerHTML = html();
}

/** Ask for everything the section shows. */
export function request(post: Post): void {
  post({ type: 'mcp', op: 'list' });
  post({ type: 'mcp', op: 'gallery' });
}

function dotTitle(s: Server): string {
  if (checking && s.state === 'unchecked') return 'checking…';
  return {
    running: 'running',
    failed: 'failed to start',
    disabled: 'disabled',
    unchecked: 'not checked',
  }[s.state];
}

function serverHtml(s: Server): string {
  const n = escapeHtml(s.name);
  const state = checking && s.state === 'unchecked' ? 'checking' : s.state;
  const cost =
    s.state === 'running'
      ? `<span class="pill" title="Tool definitions are sent with every request">${plural(s.toolCount, 'tool')} · ~${fmt(s.tokens)} tok</span>`
      : '';
  const tags = `<span class="pill">${s.kind === 'stdio' ? 'local' : 'remote'}</span>${s.origin === 'project' ? '<span class="pill" title="From this project\'s omnexx.toml or .mcp.json">project</span>' : ''}${cost}${s.allowTools.join() !== '*' ? '<span class="pill warn">filtered</span>' : ''}`;
  const needsLogin = s.kind === 'http' && s.state === 'failed' && /sign in/i.test(s.error ?? '');
  const remove =
    confirmRemove === s.name
      ? `<button class="danger-btn" data-mcp-remove-confirm="${n}">Remove</button><button class="ghost" data-mcp-remove-cancel>Cancel</button>`
      : s.origin === 'user'
        ? `<button class="ghost" data-mcp-remove="${n}" title="Remove it and its stored secrets">Remove</button>`
        : '';
  const actions = `${needsLogin ? `<button class="primary" data-mcp-login="${n}">Sign in</button>` : ''}${s.tools.length ? `<button class="ghost" data-mcp-tools="${n}" aria-expanded="${String(toolsOpen === s.name)}">Tools</button>` : ''}<button class="ghost" data-mcp-logs="${n}">Logs</button>${remove}`;
  const error =
    s.state === 'failed' && s.error
      ? `<div class="mcp-error">${escapeHtml(s.error.split('\n')[0] ?? '')}</div>`
      : '';
  return `<li class="mcp-server ${state}">
  <div class="mcp-row">
    <span class="mcp-dot ${state}" title="${escapeHtml(dotTitle(s))}" aria-label="${escapeHtml(dotTitle(s))}"></span>
    <div class="p-main"><div class="p-name">${n}</div><div class="p-url" title="${escapeHtml(s.target)}">${escapeHtml(s.target)}</div><div class="p-tags">${tags}</div>${error}</div>
    <label class="mcp-switch" title="${s.enabled ? 'Disable' : 'Enable'} ${n}"><input type="checkbox" data-mcp-enable="${n}" ${s.enabled ? 'checked' : ''} ${busy === s.name ? 'disabled' : ''}><span></span></label>
  </div>
  <div class="p-actions mcp-actions">${actions}</div>
  ${toolsOpen === s.name ? toolsHtml(s) : ''}
  ${logs?.name === s.name ? `<pre class="mcp-log">${escapeHtml(logs.text || '(no output)')}</pre>` : ''}
</li>`;
}

function toolsHtml(s: Server): string {
  const total = s.tools.filter((t) => toolChoice.has(t.name)).reduce((a, t) => a + t.tokens, 0);
  return `<div class="mcp-tools">
  <div class="mcp-tools-head"><span class="hint">${toolChoice.size}/${s.tools.length} on · ~${fmt(total)} tokens</span><button class="ghost" data-mcp-tools-all>All</button><button class="ghost" data-mcp-tools-none>None</button></div>
  ${s.tools
    .map(
      (t) =>
        `<label class="mcp-tool" title="${escapeHtml(t.description)}"><input type="checkbox" data-mcp-tool="${escapeHtml(t.name)}" ${toolChoice.has(t.name) ? 'checked' : ''}><span class="t-name">${escapeHtml(t.name)}</span><span class="t-cost">~${fmt(t.tokens)}</span></label>`,
    )
    .join('')}
  <div class="row-end"><button class="primary" data-mcp-tools-save="${escapeHtml(s.name)}">Save tools</button></div>
</div>`;
}

function listHtml(): string {
  if (!loaded) return '<p class="hint">Loading MCP servers…</p>';
  if (!servers.length)
    return '<p class="hint">No MCP servers yet. They give omnexx extra tools: a browser, your database, GitHub, Notion… Add one below.</p>';
  const running = servers.filter((s) => s.state === 'running');
  const tools = running.reduce((a, s) => a + s.toolCount, 0);
  const tokens = running.reduce((a, s) => a + s.tokens, 0);
  const summary = checking
    ? 'Starting servers to count their tools…'
    : `${plural(servers.length, 'server')} · ${plural(tools, 'tool')} · ~${fmt(tokens)} tokens per request`;
  return `<p class="hint">${summary}</p><ul class="providers mcp-list">${servers.map(serverHtml).join('')}</ul>`;
}

function cardHtml(c: Card): string {
  const on = picked?.id === c.id && picked.via === c.via;
  return `<button class="ptile mcp-card${on ? ' on' : ''}" data-mcp-card="${escapeHtml(c.via)}:${escapeHtml(c.id)}" title="${escapeHtml(c.description)}"><span class="t-label">${c.trusted ? '✓ ' : ''}${escapeHtml(c.name)}</span><span class="t-sub">${escapeHtml(c.sub)}</span></button>`;
}

function matches(c: Card): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => `${c.id} ${c.name} ${c.description}`.toLowerCase().includes(w));
}

function formHtml(c: Card): string {
  const fields = c.needs
    .map((n) => {
      const id = `mcp-need-${n.key}`;
      const help = n.help ?? n.description ?? '';
      return `<label for="${escapeHtml(id)}">${escapeHtml(n.key)}${n.required ? '' : ' <span class="muted">(optional)</span>'}</label><input id="${escapeHtml(id)}" class="field" data-mcp-need="${escapeHtml(n.key)}" type="${n.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(n.placeholder ?? help)}" value="${val(id)}">${help ? `<p class="hint">${escapeHtml(help)}</p>` : ''}`;
    })
    .join('');
  const how = c.oauth ? '<p class="hint">Opens your browser to sign in after adding.</p>' : '';
  return `<div class="mcp-form"><div class="p-name">${escapeHtml(c.name)}</div><p class="hint">${escapeHtml(c.description)}</p>${c.note ? `<p class="hint">${escapeHtml(c.note)}</p>` : ''}${fields}${how}<div class="row-end"><button class="primary" data-mcp-add-card ${busy === 'add' ? 'disabled' : ''}>${busy === 'add' ? 'Adding…' : `Add ${escapeHtml(c.name)}`}</button></div></div>`;
}

function cardsHtml(): string {
  const popular = gallery.filter(matches);
  const reg = registry.hits.length
    ? `<div class="t-group">MCP registry: "${escapeHtml(registry.query)}"</div><div class="tiles">${registry.hits.map(cardHtml).join('')}</div>`
    : '';
  const searchBtn = query.trim()
    ? `<button class="ghost" data-mcp-registry ${registry.busy ? 'disabled' : ''}>${registry.busy ? 'Searching the registry…' : `Search the MCP registry for "${escapeHtml(query.trim())}"`}</button>`
    : '';
  return `${popular.length ? `<div class="t-group">Popular</div><div class="tiles">${popular.map(cardHtml).join('')}</div>` : '<p class="hint">No popular server matches.</p>'}${reg}${searchBtn}${picked ? formHtml(picked) : ''}`;
}

function galleryHtml(): string {
  return `<input id="mcp-search" class="field" type="search" placeholder="Search filesystem, github, postgres…" aria-label="Search MCP servers" value="${escapeHtml(query)}" spellcheck="false">
<div id="mcp-cards">${cardsHtml()}</div>`;
}

function addHtml(): string {
  const segs: [AddTab, string][] = [
    ['gallery', 'Gallery'],
    ['command', 'Command'],
    ['url', 'URL'],
    ['paste', 'Paste JSON'],
  ];
  const body =
    tab === 'gallery'
      ? galleryHtml()
      : tab === 'command'
        ? `<label for="mcp-cmd-name">Name</label><input id="mcp-cmd-name" class="field" placeholder="my-server" value="${val('mcp-cmd-name')}" spellcheck="false">
<label for="mcp-cmd">Command</label><input id="mcp-cmd" class="field mono" placeholder="npx -y @scope/server-name --flag" value="${val('mcp-cmd')}" spellcheck="false">
<label for="mcp-cmd-env">Environment <span class="muted">(optional, KEY=value per line; stored privately)</span></label><textarea id="mcp-cmd-env" class="field mono" rows="2" placeholder="API_KEY=…" spellcheck="false">${val('mcp-cmd-env')}</textarea>
<div class="row-end"><button class="primary" data-mcp-add-command>Add and start</button></div>`
        : tab === 'url'
          ? `<label for="mcp-url-name">Name</label><input id="mcp-url-name" class="field" placeholder="my-service" value="${val('mcp-url-name')}" spellcheck="false">
<label for="mcp-url">URL</label><input id="mcp-url" class="field mono" type="url" placeholder="https://example.com/mcp" value="${val('mcp-url')}" spellcheck="false">
<label for="mcp-url-token">Token <span class="muted">(optional; servers with sign-in open your browser instead)</span></label><input id="mcp-url-token" class="field" type="password" autocomplete="off" value="${val('mcp-url-token')}">
<div class="row-end"><button class="primary" data-mcp-add-url>Add and connect</button></div>`
          : `<label for="mcp-json">Paste an <code>mcpServers</code> config from Claude Desktop, Cursor, Windsurf or VS Code</label><textarea id="mcp-json" class="field mono" rows="6" placeholder='{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }' spellcheck="false">${val('mcp-json')}</textarea>
<p class="hint">Tokens in env or headers go to a private secrets file, never to config.toml.</p>
<div class="row-end"><button class="primary" data-mcp-paste>Add these</button></div>`;
  return `<div class="mcp-add"><div class="seg wide" role="tablist" aria-label="How to add">${segs.map(([k, l]) => `<button role="tab" data-mcp-tab="${k}" aria-pressed="${String(tab === k)}">${l}</button>`).join('')}</div>${body}</div>`;
}

function importHtml(): string {
  if (!importable) return '';
  const fresh = importable.filter((i) => !i.have);
  if (!importable.length)
    return '<div class="mcp-import"><p class="hint">No MCP servers found in Claude Code, Claude Desktop, Cursor, VS Code or Windsurf.</p></div>';
  return `<div class="mcp-import"><div class="t-group">Found in your other tools</div>${importable
    .map(
      (i) =>
        `<label class="mcp-tool"><input type="checkbox" data-mcp-import="${escapeHtml(i.name)}" ${i.have ? 'disabled' : importChecked.has(i.name) ? 'checked' : ''}><span class="t-name">${escapeHtml(i.name)}</span><span class="t-cost">${escapeHtml(i.have ? 'already set up' : i.source)}</span></label>`,
    )
    .join(
      '',
    )}${fresh.length ? `<div class="row-end"><button class="primary" data-mcp-import-go>Import ${importChecked.size}</button></div>` : ''}</div>`;
}

/** The whole section, for the settings page. */
export function html(): string {
  const st = status
    ? `<span class="status ${status.ok ? 'ok' : 'error'}" role="status">${escapeHtml(status.text)}</span>`
    : '<span class="status" role="status"></span>';
  return `${listHtml()}
<div class="row-end mcp-bar">${st}<button class="ghost" data-mcp-refresh title="Start every server again and recount">Refresh</button><button class="ghost" data-mcp-import-scan>Import from Claude / Cursor / VS Code</button><button class="primary" data-mcp-add-toggle aria-expanded="${String(adding)}">${adding ? 'Close' : 'Add server'}</button></div>
${importHtml()}${adding ? addHtml() : ''}`;
}

function toCards(m: Record<string, unknown>): Card[] {
  const entries = Array.isArray(m.entries) ? (m.entries as Record<string, unknown>[]) : [];
  return entries.map((e) => ({
    via: 'gallery',
    id: String(e.id),
    name: String(e.name),
    description: asText(e.description),
    sub: e.oauth ? 'sign in' : e.url ? 'remote' : asText(e.command),
    needs: (e.needs as Need[] | undefined) ?? [],
    ...(typeof e.note === 'string' ? { note: e.note } : {}),
    oauth: e.oauth === true,
  }));
}

function registryCards(m: Record<string, unknown>): Card[] {
  const hits = Array.isArray(m.hits) ? (m.hits as Record<string, unknown>[]) : [];
  return hits.map((h) => ({
    via: 'registry',
    id: String(h.id),
    name: String(h.title ?? h.name),
    description: `${asText(h.description)} · runs ${asText(h.runs)}${h.trusted ? '' : ' · not a known publisher: check it first'}`,
    sub: asText(h.publisher),
    needs: (h.needs as Need[] | undefined) ?? [],
    trusted: h.trusted === true,
  }));
}

/** Messages from chat-server for this section; true when handled. */
export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  switch (m.type) {
    case 'mcpServers':
      servers = (m.servers as Server[] | undefined) ?? [];
      checking = m.checking === true;
      loaded = true;
      break;
    case 'mcpGallery':
      gallery = toCards(m);
      break;
    case 'mcpRegistry':
      registry = { query: asText(m.query), hits: registryCards(m), busy: false };
      break;
    case 'mcpImportable':
      importable = (m.servers as Importable[] | undefined) ?? [];
      importChecked = new Set(importable.filter((i) => !i.have).map((i) => i.name));
      break;
    case 'mcpLogs':
      logs = {
        name: String(m.name),
        text: [m.error, m.log].filter((x) => typeof x === 'string' && x).join('\n\n'),
      };
      busy = undefined;
      break;
    case 'mcpResult':
      status = { text: asText(m.message), ok: m.ok === true };
      if (m.ok === true && busy === 'add') {
        adding = false;
        picked = undefined;
        typed = {};
        importable = undefined;
      }
      busy = undefined;
      break;
    default:
      return false;
  }
  redraw();
  return true;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

function fail(text: string): void {
  status = { text, ok: false };
  redraw();
}

/** Send an add; the result comes back as mcpResult. */
function submit(post: Post, msg: Record<string, unknown>): void {
  busy = 'add';
  status = { text: 'Adding and starting it…', ok: true };
  post({ type: 'mcp', op: 'add', ...msg });
  redraw();
}

function addCard(post: Post): void {
  if (!picked) return;
  const values: Record<string, string> = {};
  for (const n of picked.needs) {
    const v = (typed[`mcp-need-${n.key}`] ?? '').trim();
    if (!v && n.required) {
      fail(`${n.key} is required`);
      return;
    }
    if (v) values[n.key] = v;
  }
  submit(post, { via: picked.via, id: picked.id, values });
}

function addOther(post: Post, kind: 'command' | 'url' | 'paste'): void {
  const t = (id: string): string => (typed[id] ?? '').trim();
  if (kind === 'paste') {
    if (!t('mcp-json')) {
      fail('Paste a JSON config first');
      return;
    }
    busy = 'add';
    post({ type: 'mcp', op: 'import', json: t('mcp-json') });
    redraw();
    return;
  }
  if (kind === 'command') {
    if (!t('mcp-cmd-name') || !t('mcp-cmd')) {
      fail('Give it a name and a command');
      return;
    }
    submit(post, {
      via: 'command',
      name: t('mcp-cmd-name'),
      command: t('mcp-cmd'),
      values: parseEnv(typed['mcp-cmd-env'] ?? ''),
    });
    return;
  }
  if (!t('mcp-url-name') || !/^https?:\/\/\S+$/i.test(t('mcp-url'))) {
    fail('Give it a name and a URL starting with https://');
    return;
  }
  const token = t('mcp-url-token');
  submit(post, {
    via: 'url',
    name: t('mcp-url-name'),
    url: t('mcp-url'),
    values: token ? { Authorization: /\s/.test(token) ? token : `Bearer ${token}` } : {},
  });
}

function pickCard(key: string): void {
  const [via, ...rest] = key.split(':');
  const id = rest.join(':');
  const pool = via === 'registry' ? registry.hits : gallery;
  picked = pool.find((c) => c.id === id);
  status = undefined;
}

function openTools(name: string): void {
  if (toolsOpen === name) {
    toolsOpen = undefined;
    return;
  }
  toolsOpen = name;
  const s = servers.find((x) => x.name === name);
  toolChoice = new Set(s?.tools.filter((t) => t.allowed).map((t) => t.name) ?? []);
}

function saveTools(post: Post, name: string): void {
  const s = servers.find((x) => x.name === name);
  if (!s) return;
  const all = toolChoice.size === s.tools.length;
  if (toolChoice.size === 0) {
    fail('Keep at least one tool, or switch the server off');
    return;
  }
  busy = name;
  post({ type: 'mcp', op: 'allow', name, tools: all ? [] : [...toolChoice] });
  toolsOpen = undefined;
  redraw();
}

/** Handle a click inside the section; true when it was ours. */
export function click(t: Element, post: Post): boolean {
  if (!t.closest('#mcp-box')) return false;
  const data = (attr: string): string | undefined =>
    t.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? undefined;
  const card = data('data-mcp-card');
  const tabName = data('data-mcp-tab');
  const remove = data('data-mcp-remove');
  const removeYes = data('data-mcp-remove-confirm');
  const tools = data('data-mcp-tools');
  const save = data('data-mcp-tools-save');
  const logName = data('data-mcp-logs');
  const login = data('data-mcp-login');
  if (card !== undefined) pickCard(card);
  else if (tabName !== undefined) {
    tab = tabName as AddTab;
    status = undefined;
  } else if (t.closest('[data-mcp-add-toggle]')) {
    adding = !adding;
    picked = undefined;
  } else if (t.closest('[data-mcp-refresh]')) {
    checking = true;
    post({ type: 'mcp', op: 'list' });
  } else if (t.closest('[data-mcp-import-scan]')) post({ type: 'mcp', op: 'importScan' });
  else if (t.closest('[data-mcp-import-go]')) {
    busy = 'add';
    post({ type: 'mcp', op: 'import', names: [...importChecked] });
  } else if (t.closest('[data-mcp-registry]')) {
    registry = { ...registry, busy: true };
    post({ type: 'mcp', op: 'search', query: query.trim() });
  } else if (t.closest('[data-mcp-add-card]')) addCard(post);
  else if (t.closest('[data-mcp-add-command]')) addOther(post, 'command');
  else if (t.closest('[data-mcp-add-url]')) addOther(post, 'url');
  else if (t.closest('[data-mcp-paste]')) addOther(post, 'paste');
  else if (remove !== undefined) confirmRemove = remove;
  else if (t.closest('[data-mcp-remove-cancel]')) confirmRemove = undefined;
  else if (removeYes !== undefined) {
    confirmRemove = undefined;
    busy = removeYes;
    post({ type: 'mcp', op: 'remove', name: removeYes });
  } else if (tools !== undefined) openTools(tools);
  else if (t.closest('[data-mcp-tools-all]')) {
    const s = servers.find((x) => x.name === toolsOpen);
    toolChoice = new Set(s?.tools.map((x) => x.name) ?? []);
  } else if (t.closest('[data-mcp-tools-none]')) toolChoice = new Set();
  else if (save !== undefined) {
    saveTools(post, save);
    return true;
  } else if (logName !== undefined) {
    if (logs?.name === logName) logs = undefined;
    else {
      logs = { name: logName, text: 'Starting it to collect its output…' };
      post({ type: 'mcp', op: 'logs', name: logName });
    }
  } else if (login !== undefined) {
    status = { text: `Opening your browser to sign in to ${login}…`, ok: true };
    post({ type: 'mcp', op: 'login', name: login });
  } else return t.closest('input, label, textarea') !== null;
  redraw();
  return true;
}

/** Typing, ticking and toggling inside the section. */
export function wire(page: HTMLElement, post: Post): void {
  page.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (!el.closest('#mcp-box')) return;
    if (el.id === 'mcp-search') {
      query = el.value;
      const box = document.getElementById('mcp-cards');
      if (box) box.innerHTML = cardsHtml();
    } else if (el.id) typed = { ...typed, [el.id]: el.value };
  });
  page.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.closest('#mcp-box')) return;
    const enable = el.dataset.mcpEnable;
    const tool = el.dataset.mcpTool;
    const imp = el.dataset.mcpImport;
    if (enable) {
      busy = enable;
      status = { text: `${el.checked ? 'Enabling' : 'Disabling'} ${enable}…`, ok: true };
      post({ type: 'mcp', op: 'enable', name: enable, on: el.checked });
      redraw();
    } else if (tool) {
      toolChoice = new Set(toolChoice);
      if (el.checked) toolChoice.add(tool);
      else toolChoice.delete(tool);
      redraw();
    } else if (imp) {
      importChecked = new Set(importChecked);
      if (el.checked) importChecked.add(imp);
      else importChecked.delete(imp);
      redraw();
    }
  });
}

/** Enter in the gallery search runs a registry search; true when the key was ours. */
export function keydown(e: KeyboardEvent, post: Post): boolean {
  const el = e.target;
  if (!(el instanceof Element) || !el.closest('#mcp-box')) return false;
  if (
    e.key === 'Enter' &&
    el instanceof HTMLInputElement &&
    el.id === 'mcp-search' &&
    query.trim()
  ) {
    registry = { ...registry, busy: true };
    post({ type: 'mcp', op: 'search', query: query.trim() });
    redraw();
  }
  return e.key !== 'Escape';
}
