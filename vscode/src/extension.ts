import * as vscode from 'vscode';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutonomousQueueProvider } from './autonomousQueue.js';
import { ChatViewProvider } from './chatView.js';
import { initEngine } from './engine.js';
import { control, daemonStart, daemonStatus, daemonStop, openTerminal, type Control } from './cli.js';
import {
  DIFF_SCHEME,
  DiffCodeLensProvider,
  InlineDiffReviewProvider,
  approveDiff,
  openQueueDiff,
  rejectDiff,
  taskIdFromArg,
} from './inline-diff-review.js';
import { runArgs, validateDuration, type RunOptions } from './model.js';
import { primaryFolder, RunsProvider, type Node } from './tree.js';

const DEFAULT_REFRESH_SECONDS = 5;
const MIN_REFRESH_SECONDS = 2;

export function activate(context: vscode.ExtensionContext): void {
  initEngine(context);
  const provider = new RunsProvider();
  const view = vscode.window.createTreeView('omnexx.runs', { treeDataProvider: provider });
  const refresh = (): void => {
    provider.refresh();
  };

  const cmd = (id: string, fn: (node?: Node) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (node?: Node) => {
      try {
        await fn(node);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `omnexx: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

  // Two places to see what a background run is doing, and that it finished while the panel was
  // hidden: a count on the History view's icon and a status-bar item that opens it.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'omnexx.showHistory';

  // 24/7 Autonomous Daemon status bar item + 1-click toggle
  const daemonStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  daemonStatusItem.command = 'omnexx.toggleAutonomousDaemon';
  const paintDaemonStatus = async (): Promise<void> => {
    const folder = primaryFolder();
    if (!folder) {
      daemonStatusItem.hide();
      return;
    }
    const running = await daemonStatus(folder);
    if (running) {
      daemonStatusItem.text = '$(sync~spin) 24/7 Daemon: On';
      daemonStatusItem.tooltip = 'Omnexx 24/7 Autonomous Daemon is active. Click to stop.';
    } else {
      daemonStatusItem.text = '$(play) 24/7 Daemon: Off';
      daemonStatusItem.tooltip = 'Click to launch 24/7 autonomous daemon on this repository';
    }
    daemonStatusItem.show();
  };
  void paintDaemonStatus();
  const paintStatus = (): void => {
    if (provider.unseenFinished > 0) {
      const n = provider.unseenFinished;
      view.badge = { value: n, tooltip: `${String(n)} run${n === 1 ? '' : 's'} finished` };
      status.text = `$(check) omnexx: ${String(n)} done`;
      status.tooltip = 'Open History to see what finished';
      status.show();
      return;
    }
    if (provider.activeCount > 0) {
      const n = provider.activeCount;
      view.badge = { value: n, tooltip: `${String(n)} run${n === 1 ? '' : 's'} in progress` };
      status.text = `$(sync~spin) omnexx: ${String(n)} running`;
      status.tooltip = 'Open History to watch the plan';
      status.show();
      return;
    }
    view.badge = undefined;
    status.hide();
  };

  const chat = new ChatViewProvider(context.extensionUri);
  provider.setVisible(view.visible);
  paintStatus();

  // The daemon's work queue, and inline diff review for finished tasks.
  const queueProvider = new AutonomousQueueProvider();
  const queueView = vscode.window.createTreeView('omnexx.autonomousQueueView', {
    treeDataProvider: queueProvider,
    showCollapseAll: true,
  });
  const diffProvider = new InlineDiffReviewProvider();
  const refreshQueue = (): void => {
    queueProvider.refresh();
  };

  context.subscriptions.push(
    provider,
    status,
    provider.onDidUpdate(paintStatus),
    view.onDidChangeVisibility(() => {
      provider.setVisible(view.visible);
      paintStatus();
    }),
    cmd('omnexx.showHistory', async () => {
      // Focus the History view itself, so opening the container on the Chat tab still lands here.
      try {
        await vscode.commands.executeCommand('omnexx.runs.focus');
      } catch {
        await vscode.commands.executeCommand('workbench.view.extension.omnexx');
      }
    }),
    chat,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      // Keep the conversation drawn while the panel is hidden instead of rebuilding it.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    cmd('omnexx.focusChat', () => chat.focus()),
    cmd('omnexx.newChat', () => {
      chat.newChat();
    }),
    cmd('omnexx.pickModel', () => chat.pickModel()),
    cmd('omnexx.openSettings', () => {
      chat.uiAction('settings');
    }),
    cmd('omnexx.inspectContext', () => {
      chat.uiAction('inspect');
    }),
    cmd('omnexx.toggleApproval', () => {
      chat.uiAction('approval');
    }),
    cmd('omnexx.undoLast', () => {
      chat.uiAction('undo');
    }),
    cmd('omnexx.compactChat', () => {
      chat.uiAction('compact');
    }),
    cmd('omnexx.toggleTrace', () => {
      chat.uiAction('trace');
    }),
    vscode.commands.registerCommand('omnexx.openChatSession', async (id?: unknown) => {
      if (typeof id !== 'string') return;
      await chat.focus();
      chat.resumeChat(id);
    }),
    cmd('omnexx.restartChat', () => {
      chat.restart();
    }),
    view,
    cmd('omnexx.startRun', () => startRun(false, refresh)),
    cmd('omnexx.startAutonomous', () => startRun(true, refresh)),
    queueProvider,
    queueView,
    daemonStatusItem,
    cmd('omnexx.toggleAutonomousDaemon', async () => {
      const folder = primaryFolder();
      if (!folder) throw new Error('Open a folder first.');
      const running = await daemonStatus(folder);
      if (running) {
        await daemonStop(folder);
        void vscode.window.showInformationMessage('omnexx: 24/7 autonomous daemon stopped');
      } else {
        const tomlPath = join(folder, 'omnexx.toml');
        if (!existsSync(tomlPath)) {
          writeFileSync(
            tomlPath,
            '# omnexx.toml\n[autonomous]\nenabled = true\nmode = "daemon"\ntarget_branch = "omnexx/auto-main"\nbase_branch = "main"\n',
          );
        } else {
          const content = readFileSync(tomlPath, 'utf8');
          if (!content.includes('[autonomous]')) {
            writeFileSync(
              tomlPath,
              content + '\n[autonomous]\nenabled = true\nmode = "daemon"\ntarget_branch = "omnexx/auto-main"\nbase_branch = "main"\n',
            );
          } else if (content.includes('enabled = false')) {
            writeFileSync(tomlPath, content.replace('enabled = false', 'enabled = true'));
          }
        }
        await daemonStart(folder);
        void vscode.window.showInformationMessage('omnexx: 24/7 autonomous daemon started');
      }
      refreshQueue();
      await paintDaemonStatus();
    }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),
    vscode.languages.registerCodeLensProvider({ scheme: DIFF_SCHEME }, new DiffCodeLensProvider()),
    queueView.onDidChangeVisibility(() => {
      if (queueView.visible) refreshQueue();
    }),
    cmd('omnexx.refreshAutonomousQueue', refreshQueue),
    cmd('omnexx.showQueueDiff', (arg) => {
      const taskId = typeof arg === 'string' ? arg : taskIdFromArg(arg);
      if (!taskId) throw new Error('Pick a task in the Autonomous Queue first.');
      return openQueueDiff(taskId);
    }),
    cmd('omnexx.approveDiff', (arg) => approveDiff(arg, refreshQueue)),
    cmd('omnexx.rejectDiff', (arg) => rejectDiff(arg, refreshQueue)),
    cmd('omnexx.openChat', () => {
      return openTerminal('omnexx', [], primaryFolder());
    }),
    cmd('omnexx.attach', (node) => {
      const runId = runIdOf(node);
      return openTerminal(`omnexx ${runId}`, ['watch', runId], primaryFolder());
    }),
    cmd('omnexx.pause', (node) => controlRun('pause', node, refresh)),
    cmd('omnexx.resume', (node) => controlRun('resume', node, refresh)),
    cmd('omnexx.stop', (node) => controlRun('stop', node, refresh)),
    cmd('omnexx.refresh', refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refresh();
      void paintDaemonStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('omnexx')) {
        refresh();
        void paintDaemonStatus();
      }
    }),
    autoRefresh(view, provider, paintDaemonStatus),
  );
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

/** Re-list while the sidebar is visible and a run is live, so the todo list moves on its own. */
function autoRefresh(
  view: vscode.TreeView<Node>,
  provider: RunsProvider,
  onTick?: () => Promise<void> | void,
): vscode.Disposable {
  const seconds = Math.max(
    MIN_REFRESH_SECONDS,
    vscode.workspace.getConfiguration('omnexx').get<number>('refreshSeconds') ??
      DEFAULT_REFRESH_SECONDS,
  );
  const timer = setInterval(() => {
    if (view.visible && provider.hasActiveRun) provider.refresh();
    if (onTick) void onTick();
  }, seconds * 1_000);
  return new vscode.Disposable(() => {
    clearInterval(timer);
  });
}

function runIdOf(node: Node | undefined): string {
  if (node?.kind === 'run' || node?.kind === 'plan') return node.run.runId;
  throw new Error('Pick a run in the omnexx sidebar.');
}

async function controlRun(
  action: Control,
  node: Node | undefined,
  done: () => void,
): Promise<void> {
  if (action === 'stop') {
    const ok = await vscode.window.showWarningMessage(
      'Stop this run after the current cycle?',
      { modal: true },
      'Stop',
    );
    if (ok !== 'Stop') return;
  }
  const message = await control(action, runIdOf(node), primaryFolder());
  if (message) void vscode.window.showInformationMessage(`omnexx: ${message}`);
  done();
}

/** Ask for a goal (and for autonomous runs, how long and an optional gate), then start it. */
async function startRun(autonomous: boolean, done: () => void): Promise<void> {
  const cwd = primaryFolder();
  if (!cwd) throw new Error('Open a folder (a git repository) first.');
  const goal = await vscode.window.showInputBox({
    title: autonomous ? 'omnexx: autonomous run' : 'omnexx: start run',
    prompt: 'What should the run achieve?',
    placeHolder: autonomous
      ? 'Improve the app in src/web. Only change files in that folder.'
      : 'Make the test suite pass on Node 24',
    validateInput: (v) => (v.trim() ? undefined : 'A run needs a goal.'),
  });
  if (goal === undefined) return;
  const opts = autonomous ? await askAutonomous(goal) : { goal };
  if (!opts) return;
  await openTerminal('omnexx run', runArgs(opts), cwd);
  // The detached run takes a moment to write its state; show it once it has.
  setTimeout(done, 3_000);
}

async function askAutonomous(goal: string): Promise<RunOptions | undefined> {
  const forDuration = await vscode.window.showInputBox({
    title: 'omnexx: autonomous run',
    prompt: 'Keep improving for how long?',
    value: '8h',
    validateInput: validateDuration,
  });
  if (forDuration === undefined) return;
  const gate = await vscode.window.showInputBox({
    title: 'omnexx: autonomous run',
    prompt: 'Gate command every commit must pass (leave empty to use omnexx.toml)',
    placeHolder: 'npm test',
  });
  if (gate === undefined) return;
  return { goal, forDuration, gate };
}
