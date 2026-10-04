import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PolicyError } from '../errors.js';

/** Paths the agent may never read or write, even inside the worktree. */
const DENY_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.git', '.docker', '.kube'];
const DENY_BASENAME = [
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_[a-z0-9]+(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^credentials(\.json)?$/i,
];

/** True when a path (absolute or relative) points at something that looks like a credential. */
export function isSecretPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => DENY_SEGMENTS.includes(p.toLowerCase()))) return true;
  const base = basename(path);
  return DENY_BASENAME.some((re) => re.test(base));
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
function canonical(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

export function isInside(root: string, target: string): boolean {
  const a = caseInsensitive ? root.toLowerCase() : root;
  const b = caseInsensitive ? target.toLowerCase() : target;
  if (a === b) return true;
  const rel = relative(a, b);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The path jail. Every file tool goes through `resolve()`: the result is a real path inside the
 * worktree, never through a symlink that escapes it, and never a secret-looking file.
 */
export class PathJail {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync.native(root);
  }

  resolve(userPath: string, mode: 'read' | 'write'): string {
    if (userPath.includes('\0')) throw new PolicyError('path contains a NUL byte');
    const expanded = userPath.startsWith('~')
      ? `${this.root}${sep}__home__${userPath.slice(1)}`
      : userPath;
    const abs = resolve(this.root, expanded);
    const real = canonical(abs);
    if (!isInside(this.root, real)) {
      throw new PolicyError(
        `${userPath} is outside the worktree`,
        'file tools only work on paths inside the repository',
      );
    }
    const rel = relative(this.root, real);
    if (isSecretPath(rel)) {
      throw new PolicyError(
        `${mode} of ${userPath} is denied (looks like a credential or git internals)`,
      );
    }
    return real;
  }

  relative(abs: string): string {
    return relative(this.root, abs).split(sep).join('/');
  }
}
