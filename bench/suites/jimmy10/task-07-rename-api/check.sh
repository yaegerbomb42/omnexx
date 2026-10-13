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
import { execSync } from 'node:child_process';
import { getUser } from '$REPO/src/user.js';
import { getUsr } from '$REPO/src/usr.js';
import { greet } from '$REPO/src/greet.js';
import { names } from '$REPO/src/report.js';
test('new name works, old one is a re-export', () => {
  assert.equal(getUser(2).name, 'Linus'); assert.equal(getUsr, getUser);
  assert.equal(greet(1), 'Hello, Ada'); assert.equal(names([1, 2, 3]), 'Ada, Linus, ?');
});
test('no stray references', () => {
  const hits = execSync("grep -rl getUsr src test || true", { cwd: '$REPO', encoding: 'utf8' })
    .split('\\n').filter(Boolean).filter((f) => f !== 'src/usr.js');
  assert.deepEqual(hits, []);
});
EOF
node --test "$H/hidden.test.mjs"
