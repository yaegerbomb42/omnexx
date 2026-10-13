import * as vscode from 'vscode';
import { listRuns, readPlan } from './cli.js';
import {
  childrenOf,
  describeRun,
  isActive,
  needsFix,
  progressOf,
  runsForFolders,
  type PlanNodeRow,
  type PlanView,
  type RunRow,
} from './model.js';

export type Node =
  | { kind: 'run'; run: RunRow }
  | { kind: 'plan'; run: RunRow; plan: PlanView; node: PlanNodeRow }
  | { kind: 'message'; text: string; tooltip?: string };

const STATUS_ICON: Record<PlanNodeRow['status'], vscode.ThemeIcon> = {
  todo: new vscode.ThemeIcon('circle-large-outline'),
  doing: new vscode.ThemeIcon('sync~spin'),
  done: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
  parked: new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('list.warningForeground')),
};

export function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** Where to run omnexx: the first open folder, which is also where `omnexx run` starts. */
export function primaryFolder(): string | undefined {
  return workspaceFolders()[0];
}

/** The runs sidebar: runs for the open folders, each with its milestones and tasks. */
export class RunsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Whether the last listing had a run a supervisor is still working on. */
  hasActiveRun = false;

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'message') {
      const item = new vscode.TreeItem(n.text);
      if (n.tooltip) item.tooltip = n.tooltip;
      return item;
    }
    if (n.kind === 'run') return runItem(n.run);
    return planItem(n.plan, n.node);
  }

  async getChildren(n?: Node): Promise<Node[]> {
    try {
      if (!n) return await this.runs();
      if (n.kind === 'run') return await planChildren(n.run, null);
      if (n.kind === 'plan') return childrenOf(n.plan, n.node.id).map((c) => ({ ...n, node: c }));
      return [];
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return [{ kind: 'message', text: firstLine(text), tooltip: text }];
    }
  }

  private async runs(): Promise<Node[]> {
    const all = vscode.workspace.getConfiguration('omnexx').get<boolean>('showAllRuns') ?? false;
    const runs = runsForFolders(await listRuns(primaryFolder()), workspaceFolders(), {
      all,
      caseInsensitive: process.platform !== 'linux',
    });
    this.hasActiveRun = runs.some(isActive);
    if (!runs.length) return [{ kind: 'message', text: 'No runs for this folder yet.' }];
    return runs.map((run) => ({ kind: 'run', run }));
  }
}

async function planChildren(run: RunRow, parentId: string | null): Promise<Node[]> {
  const plan = await readPlan(run.runId, primaryFolder());
  const nodes = childrenOf(plan, parentId);
  if (!nodes.length) return [{ kind: 'message', text: 'No plan yet.' }];
  return nodes.map((node) => ({ kind: 'plan', run, plan, node }));
}

function runItem(run: RunRow): vscode.TreeItem {
  const active = isActive(run);
  const item = new vscode.TreeItem(
    `${run.repoName} · ${run.runId}`,
    active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = run.runId;
  item.description = describeRun(run);
  item.tooltip = `${run.branch}\n${run.worktree}`;
  item.iconPath = healthIcon(run, active);
  // Menus in package.json key off this: pause/stop for live runs, resume for the rest, and
  // resume + stop for a run whose supervisor died or stalled.
  item.contextValue = needsFix(run) ? 'run.fix' : active ? 'run.active' : 'run.ended';
  return item;
}

function healthIcon(run: RunRow, active: boolean): vscode.ThemeIcon {
  switch (run.health) {
    case 'dead':
    case 'stalled':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    case 'waiting':
    case 'quiet':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    default:
      return new vscode.ThemeIcon(active ? 'rocket' : 'history');
  }
}

function planItem(plan: PlanView, node: PlanNodeRow): vscode.TreeItem {
  const isMilestone = node.type === 'milestone';
  const item = new vscode.TreeItem(
    `${node.id} ${node.title}`,
    isMilestone
      ? node.status === 'done'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None,
  );
  const current = node.id === plan.currentTask;
  item.iconPath = current ? new vscode.ThemeIcon('arrow-right') : STATUS_ICON[node.status];
  if (isMilestone) {
    const p = progressOf(plan, node.id);
    item.description = `${p.done}/${p.total}`;
  } else if (node.attempts > 1) {
    item.description = `${node.attempts} attempts`;
  }
  if (current) item.description = `${item.description ?? ''} working on it`.trim();
  if (node.parkedReason) item.tooltip = `Parked: ${node.parkedReason}`;
  return item;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}
