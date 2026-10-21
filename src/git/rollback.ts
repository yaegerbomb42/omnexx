import { writeFile } from 'node:fs/promises';
import { isSecretPath } from '../security/paths.js';
import { git } from './git.js';
import { workingTreeDiff } from './repo.js';

/** Drop per-file sections for credential-looking paths, then redact what's left. */
export function sanitizePatch(patch: string, redact: (s: string) => string): string {
  const sections = patch.split(/^(?=diff --git )/m);
  const kept = sections.filter((s) => {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(s);
    return !m || !(isSecretPath(m[1] ?? '') || isSecretPath(m[2] ?? ''));
  });
  return redact(kept.join(''));
}

/**
 * Save the failed attempt as a (sanitized) patch, then hard-reset the worktree to `lastGreen`.
 * Only ever called on Omnexx's own worktree; ignored files (node_modules) survive `clean -fd`.
 */
export async function rollbackTo(
  cwd: string,
  lastGreen: string,
  save?: { path: string; redact: (s: string) => string },
): Promise<{ savedPatch: boolean; exact: boolean }> {
  let savedPatch = false;
  let exact = false;
  if (save) {
    const raw = (await workingTreeDiff(cwd, lastGreen)).patch;
    const patch = sanitizePatch(raw, save.redact);
    if (patch.trim()) {
      await writeFile(save.path, patch, { mode: 0o600 });
      savedPatch = true;
      // Nothing redacted or dropped: the saved patch can be applied again as is.
      exact = patch === raw;
    }
  }
  await git(cwd, ['reset', '-q', '--hard', lastGreen]);
  await git(cwd, [
    'clean',
    '-q',
    '-fdx',
    '-e',
    'node_modules',
    '-e',
    '.venv',
    '-e',
    'venv',
    '-e',
    'target',
    '-e',
    'vendor',
  ]);
  return { savedPatch, exact };
}
