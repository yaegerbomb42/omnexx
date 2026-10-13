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
import { toCsv } from '$REPO/src/csv.js';
import { exportUsers } from '$REPO/src/export.js';
test('quoting and empties', () => {
  const rows = [{ a: 'x,y', b: 'say "hi"' }, { a: null, b: 'line\\nbreak' }];
  assert.equal(toCsv(rows, ['a', 'b']), 'a,b\\r\\n"x,y","say ""hi"""\\r\\n,"line\\nbreak"');
});
test('exportUsers', () => {
  assert.equal(exportUsers([{ id: 1, name: 'Ada', email: 'a@x.io' }]), 'id,name,email\\r\\n1,Ada,a@x.io');
  assert.equal(exportUsers([]), 'id,name,email');
});
EOF
node --test "$H/hidden.test.mjs"
