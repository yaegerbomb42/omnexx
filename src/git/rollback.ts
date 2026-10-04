import { writeFile } from 'node:fs/promises';
import { git } from './git.js';
import { workingTreeDiff } from './repo.js';

/**
 * Save the failed attempt as a patch, then hard-reset the worktree to `lastGreen`.
 * Only ever called on Omnexx's own worktree; ignored files (node_modules) survive `clean -fd`.
 */
export async function rollbackTo(
  cwd: string,
  lastGreen: string,
  patchPath?: string,
): Promise<{ savedPatch: boolean }> {
  let savedPatch = false;
  if (patchPath) {
    const { patch } = await workingTreeDiff(cwd, lastGreen);
    if (patch) {
      await writeFile(patchPath, patch, { mode: 0o600 });
      savedPatch = true;
    }
  }
  await git(cwd, ['reset', '-q', '--hard', lastGreen]);
  await git(cwd, ['clean', '-q', '-fd']);
  return { savedPatch };
}
