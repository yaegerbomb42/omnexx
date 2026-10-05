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
