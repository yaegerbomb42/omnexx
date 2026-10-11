import * as vscode from 'vscode';
import { control, openTerminal, type Control } from './cli.js';
import { runArgs, validateDuration, type RunOptions } from './model.js';
import { primaryFolder, RunsProvider, type Node } from './tree.js';

const DEFAULT_REFRESH_SECONDS = 5;
const MIN_REFRESH_SECONDS = 2;

export function activate(context: vscode.ExtensionContext): void {
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

  context.subscriptions.push(
    view,
    cmd('omnexx.startRun', () => startRun(false, refresh)),
    cmd('omnexx.startAutonomous', () => startRun(true, refresh)),
    cmd('omnexx.openChat', () => {
      openTerminal('omnexx', [], primaryFolder());
    }),
    cmd('omnexx.attach', (node) => {
      const runId = runIdOf(node);
      openTerminal(`omnexx ${runId}`, ['watch', runId], primaryFolder());
    }),
    cmd('omnexx.pause', (node) => controlRun('pause', node, refresh)),
    cmd('omnexx.resume', (node) => controlRun('resume', node, refresh)),
    cmd('omnexx.stop', (node) => controlRun('stop', node, refresh)),
    cmd('omnexx.refresh', refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('omnexx')) refresh();
    }),
    autoRefresh(view, provider),
  );
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

/** Re-list while the sidebar is visible and a run is live, so the todo list moves on its own. */
function autoRefresh(view: vscode.TreeView<Node>, provider: RunsProvider): vscode.Disposable {
  const seconds = Math.max(
    MIN_REFRESH_SECONDS,
    vscode.workspace.getConfiguration('omnexx').get<number>('refreshSeconds') ??
      DEFAULT_REFRESH_SECONDS,
  );
  const timer = setInterval(() => {
    if (view.visible && provider.hasActiveRun) provider.refresh();
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
  openTerminal('omnexx run', runArgs(opts), cwd);
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
