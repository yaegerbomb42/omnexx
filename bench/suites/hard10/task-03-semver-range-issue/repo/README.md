# minisemver

A small semver library with npm-style ranges. TypeScript run directly by Node (erasable syntax
only). Public API, from `src/index.ts`:

- `parse(v: string): SemVer | null`
- `compare(a: string, b: string): -1 | 0 | 1` (SemVer 2.0.0 precedence; build metadata ignored)
- `satisfies(version: string, range: string): boolean`

Ranges follow npm: comparators `>=1.2.3`, `<2.0.0`, `=1.2.3`, bare `1.2.3`, `^1.2.3`, `~1.2.3`;
space-separated comparators are ANDed; sets separated by `||` are ORed.
