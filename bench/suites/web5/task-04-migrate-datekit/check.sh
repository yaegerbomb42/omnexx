#!/usr/bin/env bash
set -euo pipefail

# Hidden acceptance tests, written outside the repo and run against its code.
REPO="$PWD"
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT
npm test > /dev/null 2>&1
# The vendored library must be untouched.
cmp -s "$(dirname "$0")/repo/vendor/datekit/index.js" vendor/datekit/index.js
cat > "$H/hidden.test.mjs" << EOF
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ukToIso, shiftIso } from '$REPO/src/dates.js';
test('UK to ISO', () => {
  assert.equal(ukToIso('31/12/2025'), '2025-12-31');
  assert.equal(ukToIso('01/02/2024'), '2024-02-01');
  assert.throws(() => ukToIso('31/02/2026'));
  assert.throws(() => ukToIso('2026-01-01'));
});
test('shift across month and year ends', () => {
  assert.equal(shiftIso('2025-12-31', 1), '2026-01-01');
  assert.equal(shiftIso('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftIso('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftIso('2026-03-05', 0), '2026-03-05');
});
EOF
node --test "$H/hidden.test.mjs"
