#!/usr/bin/env bash
set -euo pipefail

# Hidden acceptance tests, written outside the repo and run against its code.
REPO="$PWD"
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
npm test >/dev/null 2>&1
cat > "$H/hidden.test.mjs" << EOF
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '$REPO/src/paginate.js';
test('pages cover every item exactly once', () => {
  for (const n of [0, 1, 5, 10, 11]) for (const size of [1, 3, 5]) {
    const items = Array.from({ length: n }, (_, i) => i);
    const { totalPages } = paginate(items, 1, size);
    assert.equal(totalPages, Math.ceil(n / size));
    const seen = [];
    for (let p = 1; p <= totalPages; p++) seen.push(...paginate(items, p, size).items);
    assert.deepEqual(seen, items);
  }
});
test('page past the end is empty', () => {
  assert.deepEqual(paginate([1, 2, 3], 5, 2).items, []);
});
EOF
node --test "$H/hidden.test.mjs"
