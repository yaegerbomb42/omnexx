import * as vscode from 'vscode';
import { listChats, listRuns, readPlan } from './cli.js';
import {
  childrenOf,
  describeRun,
  HISTORY_GROUPS,
  historyGroup,
  relativeTime,
  runTitle,
  type ChatRow,
  type HistoryGroup,
  isActive,
  needsFix,
  newlyFinishedRuns,
  progressOf,
  runsForFolders,
  type PlanNodeRow,
  type PlanView,
  type RunRow,
} from './model.js';

export type Node =
  | { kind: 'group'; group: HistoryGroup; items: Node[] }
  | { kind: 'chat'; chat: ChatRow }
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

/**
 * History: past chats and runs for the open folders under Today / Yesterday / Earlier. A chat
 * reopens in the panel; a run expands to its milestones and tasks.
 */
export class RunsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Fires after a listing was computed, so the badge and status bar can follow it. */
  private readonly updated = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this.updated.event;
  /** Whether the last listing had a run a supervisor is still working on. */
  hasActiveRun = false;
  /** Runs a supervisor is working on right now. */
  activeCount = 0;
  /** Runs that ended since the History view was last looked at. */
  unseenFinished = 0;
  /** Whether the History view is on screen; a run ending in plain sight needs no badge. */
  private watched = false;
  /** All runs from the previous listing, keyed by id, to detect transitions. */
  private lastRuns = new Map<string, RunRow>();

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** The History view is open: everything that finished has now been seen. */
  markSeen(): void {
    this.unseenFinished = 0;
  }

  /** The view was opened or closed; opening it also clears the count. */
  setVisible(visible: boolean): void {
    this.watched = visible;
    if (visible) this.markSeen();
  }

  dispose(): void {
    this.changed.dispose();
    this.updated.dispose();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'message') {
      const item = new vscode.TreeItem(n.text);
      if (n.tooltip) item.tooltip = n.tooltip;
      return item;
    }
    if (n.kind === 'group') {
      const item = new vscode.TreeItem(
        n.group,
        n.group === 'Earlier'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `group:${n.group}`;
      item.description = String(n.items.length);
      return item;
    }
    if (n.kind === 'chat') return chatItem(n.chat);
    if (n.kind === 'run') return runItem(n.run);
    return planItem(n.plan, n.node);
  }

  async getChildren(n?: Node): Promise<Node[]> {
    try {
      if (!n) return await this.history();
      if (n.kind === 'group') return n.items;
      if (n.kind === 'run') return await planChildren(n.run, null);
      if (n.kind === 'plan') return childrenOf(n.plan, n.node.id).map((c) => ({ ...n, node: c }));
      return [];
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return [{ kind: 'message', text: firstLine(text), tooltip: text }];
    }
  }

  private async history(): Promise<Node[]> {
    const all = vscode.workspace.getConfiguration('omnexx').get<boolean>('showAllRuns') ?? false;
    const [allRuns, chats] = await Promise.all([
      listRuns(primaryFolder()),
      listChats(primaryFolder()),
    ]);
    const runs = runsForFolders(allRuns, workspaceFolders(), {
      all,
      caseInsensitive: process.platform !== 'linux',
    });
    this.hasActiveRun = runs.some(isActive);
    const active = runs.filter(isActive);
    this.activeCount = active.length;
    if (!this.watched) {
      this.unseenFinished += newlyFinishedRuns(runs, this.lastRuns).length;
    }
    this.lastRuns = new Map(runs.map((run) => [run.runId, run]));
    this.updated.fire();
    const dated = [
      ...chats.map((chat) => ({ at: chat.savedAt, node: { kind: 'chat' as const, chat } })),
      ...runs.map((run) => ({ at: run.startedAt, node: { kind: 'run' as const, run } })),
    ].sort((a, b) => b.at - a.at);
    if (!dated.length) return [{ kind: 'message', text: 'No chats or runs for this folder yet.' }];
    const now = Date.now();
    return HISTORY_GROUPS.flatMap((group): Node[] => {
      const items = dated.filter((d) => historyGroup(d.at, now) === group).map((d) => d.node);
      return items.length ? [{ kind: 'group', group, items }] : [];
    });
  }
}

async function planChildren(run: RunRow, parentId: string | null): Promise<Node[]> {
  const plan = await readPlan(run.runId, primaryFolder());
  const nodes = childrenOf(plan, parentId);
  if (!nodes.length) return [{ kind: 'message', text: 'No plan yet.' }];
  return nodes.map((node) => ({ kind: 'plan', run, plan, node }));
}

function chatItem(chat: ChatRow): vscode.TreeItem {
  const item = new vscode.TreeItem(chat.title, vscode.TreeItemCollapsibleState.None);
  item.id = chat.id;
  item.description = `${relativeTime(chat.savedAt, Date.now())} · ${String(chat.messages)} msg`;
  item.tooltip = `Chat: ${chat.title}\nClick to reopen it in the panel and continue.`;
  item.iconPath = new vscode.ThemeIcon('comment-discussion');
  item.contextValue = 'chat';
  item.command = { command: 'omnexx.openChatSession', title: 'Reopen chat', arguments: [chat.id] };
  return item;
}

function runItem(run: RunRow): vscode.TreeItem {
  const active = isActive(run);
  const item = new vscode.TreeItem(
    runTitle(run),
    active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = run.runId;
  item.description = `${relativeTime(run.startedAt, Date.now())} · ${describeRun(run)}`;
  item.tooltip = `Run ${run.runId} · ${run.repoName}\n${run.branch}\n${run.worktree}`;
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
