/**
 * Inline diff review: a queued task's diff as a virtual document (`omnexx-diff://`),
 * with CodeLens Approve / Reject buttons at the top. Approving marks the task approved
 * for merge; rejecting tombstones it permanently and records the reason in
 * learned_patterns. Both go through the CLI (`omnexx review approve|reject`), so the
 * verdict is the same one the terminal gives.
 */
import * as vscode from 'vscode';
import { queueInspectJson, reviewApprove, reviewReject } from './cli.js';
import { primaryFolder } from './tree.js';

export const DIFF_SCHEME = 'omnexx-diff';

interface InspectTask {
  id: string;
  title: string;
  description: string;
  collector: string;
  priorityScore: number;
  status: string;
  targetFiles: string[];
  worktreePath: string | null;
  diff: string | null;
}

/** `omnexx-diff://queue/<task-id>.diff` — the virtual document for one queued diff. */
export function diffUri(taskId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: DIFF_SCHEME, authority: 'queue', path: `/${taskId}.diff` });
}

export function taskIdOf(uri: vscode.Uri): string | null {
  if (uri.scheme !== DIFF_SCHEME) return null;
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)\.diff$/.exec(uri.path);
  return match?.[1] ?? null;
}

function renderDiff(task: InspectTask): string {
  const lines = [
    `# ${task.id} — ${task.title}`,
    `# status: ${task.status} · collector: ${task.collector} · priority: ${task.priorityScore.toFixed(1)}`,
    `# files: ${task.targetFiles.join(', ') || '(none)'}`,
    ...(task.worktreePath ? [`# worktree: ${task.worktreePath}`] : []),
    `#`,
    ...(task.description ? [`# ${task.description}`, `#`] : []),
    '',
  ];
  lines.push(task.diff ?? '(no diff recorded for this task yet)');
  return lines.join('\n');
}

/** Serves the virtual diff documents from `omnexx queue inspect <id> --json`. */
export class InlineDiffReviewProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  refresh(taskId: string): void {
    this.changed.fire(diffUri(taskId));
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const taskId = taskIdOf(uri);
    if (!taskId) return '(not a queued diff)';
    try {
      const task = JSON.parse(await queueInspectJson(taskId, primaryFolder())) as InspectTask;
      return renderDiff(task);
    } catch (err) {
      return `(could not load ${taskId}: ${err instanceof Error ? err.message : String(err)})`;
    }
  }
}

/** Approve / Reject lenses on every omnexx-diff document. */
export class DiffCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const taskId = taskIdOf(document.uri);
    if (!taskId) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        command: 'omnexx.approveDiff',
        title: '$(check) Approve',
        arguments: [taskId],
      }),
      new vscode.CodeLens(range, {
        command: 'omnexx.rejectDiff',
        title: '$(circle-slash) Reject',
        arguments: [taskId],
      }),
    ];
  }
}

/** Open a task's diff in an editor tab. */
export async function openQueueDiff(taskId: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(diffUri(taskId));
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** Approve from a tree node, a CodeLens, or the open diff editor. */
export function taskIdFromArg(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && 'task' in arg) {
    const task = (arg as { task?: { id?: unknown } }).task;
    if (task && typeof task.id === 'string') return task.id;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? taskIdOf(active) : null;
}

export async function approveDiff(arg: unknown, done: () => void): Promise<void> {
  const taskId = taskIdFromArg(arg);
  if (!taskId) throw new Error('Pick a task in the Autonomous Queue first.');
  const message = await reviewApprove(taskId, primaryFolder());
  if (message) void vscode.window.showInformationMessage(`omnexx: ${message}`);
  done();
}

export async function rejectDiff(arg: unknown, done: () => void): Promise<void> {
  const taskId = taskIdFromArg(arg);
  if (!taskId) throw new Error('Pick a task in the Autonomous Queue first.');
  const reason = await vscode.window.showInputBox({
    title: `omnexx: reject ${taskId}`,
    prompt: 'Why is this diff rejected? (saved to learned_patterns)',
    placeHolder: 'e.g. duplicates the work in #412',
  });
  if (reason === undefined) return;
  const message = await reviewReject(taskId, reason, primaryFolder());
  if (message) void vscode.window.showInformationMessage(`omnexx: ${message}`);
  done();
}
