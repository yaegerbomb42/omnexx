import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { ChatProcess, type ServerMessage } from './chatProcess.js';
import { primaryFolder } from './tree.js';

/** Commands the webview may forward to omnexx unchanged. */
const FORWARD = new Set([
  'send',
  'answer',
  'stop',
  'pause',
  'resume',
  'mode',
  'yolo',
  'undo',
  'clear',
  'compact',
  'models',
  'settings',
  'addProvider',
  'removeProvider',
  'testProvider',
]);
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
    if (type === 'pickModel') await this.pickModel();
    else if (type === 'open' && typeof m.path === 'string') await openPath(m.path);
    else if (type === 'restart') this.server.restart();
    else if (type === 'setApprovalDefault') await this.setApprovalDefault(m.on === true);
    else if (type === 'editToml')
      await openSettingsFile(join(primaryFolder() ?? homedir(), 'omnexx.toml'), PROJECT_STARTER);
    else if (type === 'editUserConfig') await openSettingsFile(userConfigPath(), USER_STARTER);
    else if (type === 'openExternal' && typeof m.url === 'string' && m.url.startsWith('https://'))
      await vscode.env.openExternal(vscode.Uri.parse(m.url));
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
<title>omnexx</title>
</head>
<body>
<header class="top">
  <div class="brand"><img class="logo" src="${logo.toString()}" alt="" width="26" height="26"><span class="word">omnexx</span></div>
  <button id="model" class="chip model" data-action="pickModel" title="Chat model: click to switch or add a provider">Pick a model</button>
  <button class="icon" data-action="settings" title="Settings" aria-label="Settings"><svg viewBox="0 0 16 16"><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zm6 3.3V7.2l-1.7-.4a4.6 4.6 0 0 0-.5-1.2l.9-1.5-1.1-1.1-1.5.9c-.4-.2-.8-.4-1.2-.5L8.8 1.7H7.2l-.4 1.7c-.4.1-.8.3-1.2.5l-1.5-.9-1.1 1.1.9 1.5c-.2.4-.4.8-.5 1.2L1.7 7.2v1.6l1.7.4c.1.4.3.8.5 1.2l-.9 1.5 1.1 1.1 1.5-.9c.4.2.8.4 1.2.5l.4 1.7h1.6l.4-1.7c.4-.1.8-.3 1.2-.5l1.5.9 1.1-1.1-.9-1.5c.2-.4.4-.8.5-1.2z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg></button>
</header>
<section class="stats" aria-label="Session">
  <div class="tile"><div class="k">Uptime</div><div class="v" id="stat-uptime">00:00:00</div></div>
  <div class="tile"><div class="k">Turns</div><div class="v" id="stat-turns">0</div></div>
  <div class="tile"><div class="k">Tokens</div><div class="v" id="stat-tokens">0</div></div>
  <div class="tile"><div class="k">Cost</div><div class="v" id="stat-cost">$0.00</div></div>
  <div class="ctx" title="Context in use; omnexx compacts the conversation when it fills"><span class="k">Context</span><div class="track"><div class="fill" id="ctx-fill"></div></div><span id="ctx-text">—</span></div>
</section>
<div class="toolbar">
  <div class="seg" role="group" aria-label="Mode">
    <button data-mode="chat" aria-pressed="true" title="Work turn by turn with you">Act</button>
    <button data-mode="plan" aria-pressed="false" title="Investigate and propose a plan; no edits">Plan</button>
    <button data-mode="run" aria-pressed="false" title="Start a long autonomous run in the background">Autonomous</button>
  </div>
  <button id="approval" class="chip" data-action="approval">Ask first</button>
</div>
<div id="banner" class="banner" hidden role="status"></div>
<details id="steps" class="section steps" open hidden>
  <summary><span class="chev" aria-hidden="true"></span><span class="h">Trajectory</span><span class="sub-h">Step-by-step flow</span><span id="steps-count" class="count"></span></summary>
  <ol id="steps-body" class="timeline"></ol>
</details>
<section id="welcome" class="welcome">
  <h2>What should omnexx do?</h2>
  <p>It edits this workspace, runs your tests, and asks before anything outside the repo.</p>
  <div class="suggestions">
    <button data-suggest="Explain how this project is structured and where to start reading.">Explain this codebase</button>
    <button data-suggest="Run the tests and fix whatever fails.">Fix failing tests</button>
    <button data-suggest="Find likely bugs in the code I changed recently and fix them.">Review recent changes</button>
  </div>
</section>
<main id="log" class="conversation" aria-live="polite"></main>
<section id="settings" class="settings" hidden aria-label="Settings"></section>
<section id="ask" class="ask" hidden role="alertdialog" aria-labelledby="ask-text">
  <div class="ask-title">Approval needed</div>
  <div id="ask-text"></div>
  <div class="ask-buttons">
    <button class="primary" data-action="allow">Allow</button>
    <button class="secondary" data-action="deny">Deny</button>
  </div>
</section>
<details class="section live" open>
  <summary><span class="chev" aria-hidden="true"></span><span class="h">Live log</span><span class="sub-h">actions &amp; thinking</span><button class="icon small" data-action="clear-log" title="Clear the log" aria-label="Clear the log"><svg viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.5h4V4m-5.5 0 .5 9.5h6l.5-9.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button></summary>
  <div id="live-log" class="live-log" role="log"></div>
</details>
<footer class="composer">
  <div class="input-wrap">
    <textarea id="input" rows="1" aria-label="Message omnexx"></textarea>
    <button id="send" class="send" title="Send (Enter)" aria-label="Send"><svg viewBox="0 0 16 16"><path d="M2 8l11-5-3.5 11-2.2-4.3z M7.3 9.7 13 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></button>
  </div>
  <div class="side">
    <button id="pause" class="icon ctl" data-action="pause" title="Pause after the current step" aria-label="Pause or resume" disabled><svg viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
    <button id="stop" class="icon ctl stop" data-action="stop" title="Stop (Esc)" aria-label="Stop" disabled><svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg></button>
  </div>
  <div class="row">
    <button class="link" data-action="clear" title="Start a fresh conversation">New chat</button>
    <button class="link" data-action="undo" title="Put the files back as they were before your last message">Undo</button>
    <button class="link" data-action="compact" title="Summarize the conversation to free context">Compact</button>
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
