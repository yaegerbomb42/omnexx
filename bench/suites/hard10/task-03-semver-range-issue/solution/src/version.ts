export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parse(v: string): SemVer | null {
  const m = RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

function cmp(a: number | string, b: number | string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

const NUMERIC = /^\d+$/;

function compareIdent(a: string, b: string): -1 | 0 | 1 {
  const an = NUMERIC.test(a);
  const bn = NUMERIC.test(b);
  if (an && bn) return cmp(Number(a), Number(b));
  if (an) return -1;
  if (bn) return 1;
  return cmp(a, b);
}

function comparePre(a: string[], b: string[]): -1 | 0 | 1 {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const r = compareIdent(a[i] ?? '', b[i] ?? '');
    if (r) return r;
  }
  return cmp(a.length, b.length);
}

export function compareParsed(a: SemVer, b: SemVer): -1 | 0 | 1 {
  return (
    cmp(a.major, b.major) ||
    cmp(a.minor, b.minor) ||
    cmp(a.patch, b.patch) ||
    comparePre(a.prerelease, b.prerelease)
  );
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new TypeError(`Invalid version: ${!pa ? a : b}`);
  return compareParsed(pa, pb);
}
