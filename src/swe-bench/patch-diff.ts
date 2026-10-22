import { git } from '../git/git.js';
import { isVendored } from '../agent/codemap.js';

/**
 * Patch diff extraction for SWE-bench submission format.
 *
 * Extracts a clean unified diff of the changes made to fix an issue,
 * filtering out vendored files and formatting for submission.
 */

export interface PatchDiff {
  files: string[];
  diff: string;
  stats: { additions: number; deletions: number };
}

/**
 * Extract the patch diff between two commits (or HEAD~1 and HEAD).
 */
export async function extractPatchDiff(
  root: string,
  contextLines = 3,
  fromRef = 'HEAD~1',
  toRef = 'HEAD',
): Promise<PatchDiff> {
  const diffOut = await git(root, [
    'diff',
    `--unified=${contextLines}`,
    '--no-color',
    '--no-prefix',
    fromRef,
    toRef,
  ]);

  if (diffOut.exitCode !== 0 || !diffOut.stdout.trim()) {
    return { files: [], diff: '', stats: { additions: 0, deletions: 0 } };
  }

  const rawDiff = diffOut.stdout;
  const filteredDiff = filterVendoredFiles(rawDiff);
  const files = extractChangedFiles(filteredDiff);
  const stats = computeDiffStats(filteredDiff);

  return { files, diff: filteredDiff, stats };
}

/**
 * Filter out sections for vendored files from a diff.
 */
function filterVendoredFiles(diff: string): string {
  const sections = diff.split(/^(?=diff --git )/m);
  const filtered = sections.filter((section) => {
    const pathMatch = /^diff --git a\/(\S+)/.exec(section);
    const path = pathMatch?.[1];
    return !path || !isVendored(path);
  });
  return filtered.join('');
}

/**
 * Extract the list of changed files from a diff.
 */
function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  const lines = diff.split('\n');

  for (const line of lines) {
    const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (match) {
      files.push(match[2] ?? match[1] ?? '');
    }
  }

  return [...new Set(files.filter(Boolean))];
}

/**
 * Compute addition/deletion stats from a diff.
 */
function computeDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return { additions, deletions };
}

/**
 * Format a diff for SWE-bench submission.
 * Strips git headers and normalizes paths.
 */
export function formatForSubmission(diff: string): string {
  const lines = diff.split('\n');
  const output: string[] = [];
  let inHeader = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      inHeader = true;
      continue;
    }
    if (line.startsWith('index ') && inHeader) {
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++')) {
      inHeader = false;
      const path = line.slice(4).replace(/^a\/|^b\//, '');
      output.push(`${line.slice(0, 3)} ${path}`);
      continue;
    }
    output.push(line);
  }

  return output.join('\n').trim();
}

/**
 * Get the diff against the base commit (before any edits in this session).
 */
export async function getDiffFromBase(
  root: string,
  baseCommit: string,
  contextLines = 3,
): Promise<PatchDiff> {
  return extractPatchDiff(root, contextLines, baseCommit, 'HEAD');
}

/**
 * Check if the diff is empty (no actual changes).
 */
export function isDiffEmpty(patch: PatchDiff): boolean {
  return patch.files.length === 0 && patch.stats.additions === 0 && patch.stats.deletions === 0;
}

/**
 * Summarize the patch for logging/display.
 */
export function summarizePatch(patch: PatchDiff): string {
  if (isDiffEmpty(patch)) return 'No changes';

  const fileList = patch.files.slice(0, 5).join(', ');
  const more = patch.files.length > 5 ? ` (+${patch.files.length - 5} more)` : '';

  return `${patch.files.length} files changed: ${fileList}${more} (+${patch.stats.additions}/-${patch.stats.deletions})`;
}
