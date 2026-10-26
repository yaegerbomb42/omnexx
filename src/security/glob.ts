/**
 * Minimal gitignore-style glob for protected paths: `**` spans directories, `*` and `?`
 * stay within one segment. A pattern without `/` matches the basename at any depth.
 * Written here because node's path.matchesGlob is still experimental on Node 22.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/^\.\//, '');
  const anchored = p.includes('/');
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p.charAt(i);
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slash = p[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re}$`);
}

export function matchesAny(path: string, patterns: readonly string[]): string | undefined {
  const normalized = path.replace(/\\/g, '/');
  return patterns.find((p) => globToRegExp(p).test(normalized));
}

/**
 * Dependency and build folders: not the project's code even when a repo commits them. Shared
 * by the codemap (which files are project code) and the anti-cheat scan (markers in
 * tool-written output say nothing about cheating: `npm install` writes node_modules, a test
 * run writes coverage).
 */
export const VENDORED_PATH =
  /(^|\/)(node_modules|bower_components|vendor|dist|build|\.venv|venv|__pycache__|target|\.next|coverage)\//;

export const isVendored = (path: string): boolean => VENDORED_PATH.test(path);
