import { isInside } from './paths.js';

export interface ExtraPolicyVerdict {
  readonly allowed: boolean;
  readonly rule?: string;
  readonly reason?: string;
}

/**
 * Checks policy rules for tools:
 * 1. Browser eval / javascript execution is off by default.
 * 2. MCP tools tagged destructive require policy approval (or are denied).
 * 3. Workers must execute strictly inside an isolated worktree.
 */
export function checkBrowserToolPolicy(
  action: string,
  options: { readonly allowEval?: boolean } = {},
): ExtraPolicyVerdict {
  if (action === 'evaluate' || action === 'eval' || action === 'execute_script') {
    if (!options.allowEval) {
      return {
        allowed: false,
        rule: 'browser-eval-disabled',
        reason: 'browser JavaScript evaluation is disabled by default for safety',
      };
    }
  }
  return { allowed: true };
}

export function checkMcpToolPolicy(
  toolName: string,
  toolMeta: {
    readonly destructive?: boolean;
    readonly annotations?: { readonly destructive?: boolean };
  } = {},
  options: { readonly allowDestructiveMcp?: boolean } = {},
): ExtraPolicyVerdict {
  const isDestructive = toolMeta.destructive === true || toolMeta.annotations?.destructive === true;
  if (isDestructive && !options.allowDestructiveMcp) {
    return {
      allowed: false,
      rule: 'mcp-destructive-unapproved',
      reason: `MCP tool "${toolName}" is tagged as destructive and requires explicit policy approval`,
    };
  }
  return { allowed: true };
}

export function checkWorkerWorktreePolicy(
  worktreePath: string,
  repoRoot: string,
  runHome: string,
): ExtraPolicyVerdict {
  // A worker must run in an isolated worktree, never directly in repoRoot.
  if (worktreePath === repoRoot) {
    return {
      allowed: false,
      rule: 'worker-not-in-worktree',
      reason: 'worker backends must run in an isolated worktree, never the primary repo root',
    };
  }

  // Worktree must reside under runHome or dedicated worktrees folder
  const allowedParents = [runHome];
  const insideAllowed = allowedParents.some((p) => isInside(p, worktreePath));
  if (!insideAllowed) {
    return {
      allowed: false,
      rule: 'worker-worktree-outside-home',
      reason: `worker worktree ${worktreePath} is outside the allowed directory hierarchy`,
    };
  }

  return { allowed: true };
}
