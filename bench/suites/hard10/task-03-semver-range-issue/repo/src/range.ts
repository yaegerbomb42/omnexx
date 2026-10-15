import { compareParsed, parse, type SemVer } from './version.ts';

type Op = '>=' | '<=' | '>' | '<' | '=';
interface Comparator {
  op: Op;
  v: SemVer;
}

const bump = (v: SemVer, part: 'major' | 'minor' | 'patch'): SemVer => ({
  major: part === 'major' ? v.major + 1 : v.major,
  minor: part === 'major' ? 0 : part === 'minor' ? v.minor + 1 : v.minor,
  patch: part === 'patch' ? v.patch + 1 : 0,
  prerelease: [],
});

function expand(token: string): Comparator[] {
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) throw new TypeError(`Invalid comparator: ${token}`);
  const v = parse(m[2] ?? '');
  if (!v) throw new TypeError(`Invalid comparator: ${token}`);
  const op = m[1] ?? '=';
  if (op === '^') return [{ op: '>=', v }, { op: '<', v: bump(v, 'major') }];
  if (op === '~') return [{ op: '>=', v }, { op: '<', v: bump(v, 'minor') }];
  return [{ op: op as Op, v }];
}

function test(c: Comparator, v: SemVer): boolean {
  const r = compareParsed(v, c.v);
  switch (c.op) {
    case '>=':
      return r >= 0;
    case '<=':
      return r <= 0;
    case '>':
      return r > 0;
    case '<':
      return r < 0;
    default:
      return r === 0;
  }
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range.split('||').some((set) => {
    const comparators = set.trim().split(/\s+/).filter(Boolean).flatMap(expand);
    return comparators.every((c) => test(c, v));
  });
}
