import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { ChatProcess, type ServerMessage } from './chatProcess.js';
import { BUNDLED_VERSION, engine, refreshEngine } from './engine.js';
import { FORWARD } from './forward.js';
import { primaryFolder } from './tree.js';

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const MODEL_LIST_TIMEOUT_MS = 15_000;

interface ModelItem {
  ref: string;
  provider: string;
  model: string;
}

/** The Cline-style chat in the omnexx sidebar, backed by `omnexx chat-server`. */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'omnexx.chat';
  private view: vscode.WebviewView | undefined;
  private readonly server: ChatProcess;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Paths the latest contextFiles listed: the only files the explorer may open. */
  private contextPaths = new Map<string, boolean>();
  private modelsWaiter: ((items: ModelItem[], unreachable: string[]) => void) | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.server = new ChatProcess(primaryFolder());
    this.subscriptions.push(
      this.server,
      this.server.onMessage((m) => {
        this.fromServer(m);
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const out = vscode.Uri.joinPath(this.extensionUri, 'out');
    view.webview.options = { enableScripts: true, localResourceRoots: [media, out] };
    view.webview.html = this.html(view.webview);
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((m: { type?: unknown } & Record<string, unknown>) => {
        void this.fromWebview(m).catch((err: unknown) => {
          void vscode.window.showErrorMessage(
            `omnexx: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }),
    );
  }

  /** Focus the panel and put the cursor in the input. */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  newChat(): void {
    this.server.send({ type: 'clear' });
  }

  /** Reopen a saved chat from History: its transcript shows and the conversation continues. */
  resumeChat(id: string): void {
    if (!this.server.running) this.server.start();
    this.server.send({ type: 'resumeChat', id });
  }

  /** Workspace files for `@` mentions, relative to their folder; build output and deps skipped. */
  private async postFiles(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*',
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/target/**,**/.next/**}',
      FILE_MENTION_LIMIT,
    );
    const items = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
    this.post({ type: 'files', items });
  }

  /** Dropped file URIs as `@path` mentions; anything that isn't a URI is ignored. */
  private postMention(uris: readonly unknown[]): void {
    const paths: string[] = [];
    for (const u of uris) {
      if (typeof u !== 'string' || !URI_SCHEME.test(u)) continue;
      paths.push(vscode.workspace.asRelativePath(vscode.Uri.parse(u), false));
    }
    if (paths.length)
      this.post({ type: 'insert', text: `${paths.map((p) => `@${p}`).join(' ')} ` });
  }

  /** Runs a panel control from a title-bar command (settings, approvals, trace…). */
  uiAction(action: string): void {
    this.post({ type: 'ui', action });
  }

  restart(): void {
    this.server.restart();
  }

  private post(msg: object): void {
    void this.view?.webview.postMessage(msg);
  }

  private fromServer(m: ServerMessage): void {
    if (m.type === 'ready') {
      // A new omnexx process: apply the approval default from settings.
      if (approvalDefault()) this.server.send({ type: 'yolo', on: true });
      this.post({ type: 'prefs', autoApproveDefault: approvalDefault() });
    }
    if (m.type === 'contextFiles' && Array.isArray(m.files)) {
      this.contextPaths = new Map(
        (m.files as { path?: unknown; editable?: unknown }[]).flatMap((f) =>
          typeof f.path === 'string' ? [[f.path, f.editable === true] as [string, boolean]] : [],
        ),
      );
    }
    if (m.type === 'models' && this.modelsWaiter) {
      this.modelsWaiter(
        (m.items as ModelItem[] | undefined) ?? [],
        (m.unreachable as string[] | undefined) ?? [],
      );
      this.modelsWaiter = undefined;
    }
    this.post(m);
  }

  private async fromWebview(m: { type?: unknown } & Record<string, unknown>): Promise<void> {
    const type = typeof m.type === 'string' ? m.type : '';
    if (type === 'ready') {
      // A reloaded panel gets the whole conversation again; a first one starts omnexx.
      if (this.server.running) this.server.send({ type: 'sync' });
      else this.server.start();
      return;
    }
    if (FORWARD.has(type)) {
      this.server.send({ ...m, type });
      return;
    }
    if (type === 'files') await this.postFiles();
    else if (type === 'mention' && Array.isArray(m.uris)) this.postMention(m.uris);
    else if (type === 'copy' && typeof m.text === 'string')
      await vscode.env.clipboard.writeText(m.text);
    else if (type === 'pickModel') await this.pickModel();
    else if (type === 'open' && typeof m.path === 'string') await openPath(m.path);
    else if (type === 'restart') this.server.restart();
    else if (type === 'setApprovalDefault') await this.setApprovalDefault(m.on === true);
    else if (type === 'openContextFile' && typeof m.path === 'string')
      await this.openContext(m.path);
    else if (type === 'engineInfo') await this.postEngine();
    else if (type === 'installCli') this.installCli();
    else if (type === 'editToml')
      await openSettingsFile(join(primaryFolder() ?? homedir(), 'omnexx.toml'), PROJECT_STARTER);
    else if (type === 'editUserConfig') await openSettingsFile(userConfigPath(), USER_STARTER);
    else if (type === 'openExternal' && typeof m.url === 'string' && m.url.startsWith('https://'))
      await vscode.env.openExternal(vscode.Uri.parse(m.url));
  }

  /** Which omnexx the panel runs, for Settings. */
  private async postEngine(): Promise<void> {
    try {
      const e = await engine();
      this.post({
        type: 'engine',
        source: e.source,
        version: e.version ?? null,
        bundled: BUNDLED_VERSION,
      });
    } catch (err) {
      this.post({
        type: 'engine',
        source: 'missing',
        version: null,
        bundled: BUNDLED_VERSION,
        error: String(err),
      });
    }
  }

  /** Install omnexx for the terminal: Homebrew when it's there, else npm (needs Node 22+). */
  private installCli(): void {
    // Homebrew's own install locations (Apple silicon, Intel), not whatever PATH finds first.
    const brew = BREW_PATHS.some((p) => existsSync(p));
    const cmd = brew
      ? 'brew install yaegerbomb42/omnexx/omnexx'
      : `npm install -g omnexx@${BUNDLED_VERSION}`;
    const terminal = vscode.window.createTerminal({ name: 'Install omnexx' });
    terminal.show();
    terminal.sendText(cmd);
    void vscode.window.showInformationMessage(
      'omnexx: installing for your terminal. The panel switches to it on its next start (or Restart omnexx in Settings).',
    );
    refreshEngine();
  }

  /** Open a listed context file; an editable one that doesn't exist yet is created first. */
  private async openContext(path: string): Promise<void> {
    const editable = this.contextPaths.get(path);
    if (editable === undefined) return;
    if (editable) await openSettingsFile(path, '');
    else {
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: true });
      } catch {
        void vscode.window.showInformationMessage(
          'omnexx: this context file appears after the next run cycle.',
        );
      }
    }
  }

  private async setApprovalDefault(on: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration('omnexx')
      .update('autoApprove', on, vscode.ConfigurationTarget.Global);
    this.server.send({ type: 'yolo', on });
    this.post({ type: 'prefs', autoApproveDefault: on });
  }

  private listModels(): Promise<{ items: ModelItem[]; unreachable: string[] }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.modelsWaiter = undefined;
        reject(new Error('omnexx took too long to list models'));
      }, MODEL_LIST_TIMEOUT_MS);
      this.modelsWaiter = (items, unreachable) => {
        clearTimeout(timer);
        resolve({ items, unreachable });
      };
      this.server.send({ type: 'models' });
    });
  }

  async pickModel(): Promise<void> {
    const loading = vscode.window.createQuickPick();
    loading.title = 'omnexx: chat model';
    loading.busy = true;
    loading.placeholder = 'Loading models from your providers…';
    loading.show();
    let listed: { items: ModelItem[]; unreachable: string[] };
    try {
      listed = await this.listModels();
    } finally {
      loading.dispose();
    }
    const add: vscode.QuickPickItem[] = [
      {
        label: '$(key) Add an API key…',
        description: 'OpenAI, OpenRouter, Groq, Gemini, xAI, Anthropic…',
      },
      {
        label: '$(link) Add an endpoint…',
        description: 'any OpenAI-compatible URL, e.g. Ollama or LM Studio',
      },
    ];
    const byProvider = new Map<string, ModelItem[]>();
    for (const i of listed.items)
      byProvider.set(i.provider, [...(byProvider.get(i.provider) ?? []), i]);
    const picks: (vscode.QuickPickItem & { ref?: string })[] = [];
    for (const [provider, items] of byProvider) {
      picks.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
      for (const i of items) picks.push({ label: i.model, description: provider, ref: i.ref });
    }
    picks.push({ label: 'Add', kind: vscode.QuickPickItemKind.Separator }, ...add);
    const chosen = await vscode.window.showQuickPick(picks, {
      title: 'omnexx: chat model',
      placeHolder: listed.unreachable.length
        ? `Pick a model (couldn't reach: ${listed.unreachable.join(', ')})`
        : 'Pick a model, or add a provider',
      matchOnDescription: true,
    });
    if (!chosen) return;
    if (chosen.ref) this.server.send({ type: 'model', ref: chosen.ref });
    else if (chosen.label.includes('API key')) await this.addKey();
    else await this.addEndpoint();
  }

  private async addKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: 'omnexx: add an API key',
      prompt: 'Paste the key. omnexx recognizes the provider from it and stores it in a 0600 file.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length >= 16 ? undefined : 'That looks too short for a key.'),
    });
    if (key) this.server.send({ type: 'connect', value: key.trim() });
  }

  private async addEndpoint(): Promise<void> {
    const url = await vscode.window.showInputBox({
      title: 'omnexx: add an endpoint',
      prompt: 'The base URL of an OpenAI-compatible API',
      placeHolder: 'http://localhost:11434/v1',
      ignoreFocusOut: true,
      validateInput: (v) =>
        /^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter an http(s) URL.',
    });
    if (!url) return;
    const key = await vscode.window.showInputBox({
      title: 'omnexx: add an endpoint',
      prompt: 'API key for it (leave empty if it needs none, like a local server)',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    this.server.send({
      type: 'connect',
      value: [url.trim(), key.trim()].filter(Boolean).join(' '),
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const settingsCss = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'settings.css'),
    );
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'chat.js'));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'logo.png'));
    const csp = [
      "default-src 'none'",
      // Inline styles: the context bar's width is set per update.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css.toString()}">
<link rel="stylesheet" href="${settingsCss.toString()}">
<title>omnexx</title>
</head>
<body data-logo="${logo.toString()}">
<div id="banner" class="banner" hidden role="status"></div>
<details id="steps" class="mission" hidden>
  <summary><span class="chev" aria-hidden="true"></span><span id="steps-now" class="now"></span><span id="steps-count" class="count"></span><span class="track"><span id="steps-bar" class="fill"></span></span></summary>
  <ol id="steps-body" class="timeline"></ol>
</details>
<div id="model-picker" class="model-picker" hidden role="dialog" aria-label="Pick a model"></div>
<section id="welcome" class="welcome">
  <h2>What should omnexx do?</h2>
  <p>It edits this workspace, runs your tests, and asks before anything outside the repo.</p>
  <div class="suggestions">
    <button data-suggest="Explain how this project is structured and where to start reading.">Explain this codebase</button>
    <button data-suggest="Run the tests and fix whatever fails.">Fix failing tests</button>
    <button data-suggest="Find likely bugs in the code I changed recently and fix them.">Review recent changes</button>
  </div>
</section>
<details id="crew" class="section crew" open hidden>
  <summary><span class="chev" aria-hidden="true"></span><span class="h">Crew</span><span class="sub-h">helpers report to omnexx</span><span id="crew-count" class="count"></span></summary>
  <div id="crew-body" class="crew-body"></div>
</details>
<details id="browser" class="section browser" open hidden>
  <summary><span class="chev" aria-hidden="true"></span><span class="h">Browser</span><span class="sub-h">what the agent sees</span></summary>
  <div class="bframe"><div class="bbar"><span class="bdots" aria-hidden="true"><i></i><i></i><i></i></span><span id="b-url" class="burl"></span><span id="b-action" class="baction"></span></div><img id="b-img" alt="The agent's browser" title="Click to enlarge"></div>
</details>
<section id="agent-start" class="agent-start" hidden aria-label="Agent settings"></section>
<main id="log" class="conversation" aria-live="polite"></main>
<button id="jump" class="jump" hidden title="Jump to latest" aria-label="Jump to latest"><svg viewBox="0 0 16 16"><path d="M8 3v9M4 8.5 8 12.5 12 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<section id="settings" class="settings" hidden aria-label="Settings"></section>
<section id="ctxpage" class="settings" hidden aria-label="Context files"></section>
<section id="inspector" class="settings" hidden aria-label="Context inspector"></section>
<section id="ask" class="ask" hidden role="alertdialog" aria-labelledby="ask-text">
  <div id="ask-title" class="ask-title">Approval needed</div>
  <div id="ask-text"></div>
  <div class="ask-buttons">
    <button id="ask-yes" class="primary" data-action="allow" title="Allow (⌘/Ctrl+Enter)">Allow</button>
    <button id="ask-no" class="secondary" data-action="deny" title="Deny (Esc)">Deny</button>
    <span class="ask-keys">⌘/Ctrl+Enter allow · Esc deny</span>
  </div>
</section>
<footer class="composer">
  <div id="suggest" class="suggest" hidden role="listbox" aria-label="Suggestions"></div>
  <div class="input-wrap">
    <textarea id="input" rows="1" aria-label="Message omnexx"></textarea>
    <button id="send" class="send" title="Send (Enter)" aria-label="Send"><svg class="stop-ico" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg><svg class="send-ico" viewBox="0 0 16 16"><path d="M2 8l11-5-3.5 11-2.2-4.3z M7.3 9.7 13 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></button>
  </div>
  <div class="row">
    <div class="modes" role="group" aria-label="Mode">
      <button data-mode="chat" aria-pressed="true" title="Work turn by turn with you">Chat</button>
      <button data-mode="plan" aria-pressed="false" title="Investigate and propose a plan; no edits">Plan</button>
      <button data-mode="run" aria-pressed="false" title="Autonomous: start a long run in the background">Run</button>
    </div>
    <button id="model" class="chip model" data-action="pickModel" title="Chat model: click to switch or add a provider">Pick a model</button>
    <span class="grow"></span>
    <span id="stat-cache-pill" class="chip hud-cache" title="Prompt cache hit percentage">⚡ 0% cache</span>
    <button id="approval" class="chip danger" data-action="approval" hidden title="omnexx goes ahead without asking; click to ask first again">Auto-approve</button>
    <button class="meter" data-action="inspect" title="Context in use; click to see, edit or delete what the model gets"><span class="track"><span class="fill" id="ctx-fill"></span></span><span id="ctx-text">—</span></button>
    <button class="chip cost" data-action="usage" aria-haspopup="true" title="Session usage"><span id="stat-cost">$0.00</span></button>
    <button id="pause" class="icon ctl" data-action="pause" title="Pause after the current step" aria-label="Pause or resume" disabled hidden><svg viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
  </div>
  <div id="usage-pop" class="pop usage" hidden role="dialog" aria-label="Session usage">
    <div class="row"><span class="k">Uptime</span><span class="v" id="stat-uptime">00:00:00</span></div>
    <div class="row"><span class="k">Turns</span><span class="v" id="stat-turns">0</span></div>
    <div class="row"><span class="k">Tokens</span><span class="v" id="stat-tokens">0</span></div>
    <div id="ctx-parts" class="ctx-parts"></div>
  </div>
</footer>
<script nonce="${nonce}" src="${js.toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}

/** A dropped string that is a URI (`file:///…`, `vscode-remote://…`), not plain dragged text. */
const URI_SCHEME = /^[a-z][\w+.-]*:\/\//i;

/** Files offered for `@` mentions; past this a big repo is sampled, not listed in full. */
const FILE_MENTION_LIMIT = 5000;

const PROJECT_STARTER = '# omnexx project settings: see `omnexx init`\n';
const USER_STARTER = '# omnexx user settings\n';

function approvalDefault(): boolean {
  return vscode.workspace.getConfiguration('omnexx').get<boolean>('autoApprove') ?? false;
}

function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = process.env.OMNEXX_CONFIG_HOME ?? join(xdg ?? join(homedir(), '.config'), 'omnexx');
  return join(home, 'config.toml');
}

async function openSettingsFile(path: string, starter: string): Promise<void> {
  const uri = vscode.Uri.file(path);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(starter));
  }
  await vscode.window.showTextDocument(uri);
}

/** Open `src/a.ts` or `src/a.ts:12` from a reply, relative to the workspace. */
async function openPath(spec: string): Promise<void> {
  const m = /^(.*?)(?::(\d+))?$/.exec(spec);
  const file = m?.[1] ?? spec;
  const line = m?.[2] ? Number(m[2]) - 1 : undefined;
  const root = primaryFolder();
  const path = isAbsolute(file) || !root ? file : join(root, file);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line !== undefined) {
      const pos = new vscode.Position(Math.max(0, line), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch {
    void vscode.window.showWarningMessage(`omnexx: couldn't open ${file}`);
  }
}
