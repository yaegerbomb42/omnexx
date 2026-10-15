# Task: Fix Issue #212, "Caret ranges on 0.x and prerelease handling are wrong"

> **Issue #212** (opened by a downstream package manager)
>
> We resolve dependency ranges with `satisfies()` and got bitten three ways:
>
> 1. `satisfies('0.3.0', '^0.2.3')` is `true`. npm treats `^0.2.3` as `>=0.2.3 <0.3.0`, and
>    `^0.0.3` as `>=0.0.3 <0.0.4`. We pulled a breaking 0.x release.
> 2. `compare('1.0.0-alpha.10', '1.0.0-alpha.2')` returns `-1`. Per SemVer 2.0.0 §11, numeric
>    identifiers compare numerically, numeric identifiers sort before alphanumeric ones, and a
>    larger set of identifiers wins when all preceding ones are equal
>    (`1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 <
1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0`).
> 3. `satisfies('2.0.0-rc.1', '>=1.0.0')` is `true`, so we installed a release candidate. npm
>    only lets a prerelease version satisfy a range when some comparator in the same `||` set
>    has a prerelease on the same `major.minor.patch` (so `1.2.3-beta.4` satisfies
>    `^1.2.3-beta.2` but `1.2.4-beta.1` does not, and `2.0.0-rc.1` does not satisfy `>=1.0.0`).
>
> Expected: npm semantics for all of the above. Caret and tilde on prerelease versions should
> keep working too (`^1.2.3-beta.2` is `>=1.2.3-beta.2 <2.0.0`).

Fix the library so it matches npm's `semver` behavior for these cases, without breaking the
existing public API (`parse`, `compare`, `satisfies` from `src/index.ts`). Add regression tests.
No new dependencies.

## Success Criteria

- `npm test` passes
- All three reported behaviors match npm `semver`; existing behavior for plain releases is kept
