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
import { loadAll } from '$REPO/src/loader.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('order and concurrency limit', async () => {
  let active = 0, peak = 0;
  const ids = Array.from({ length: 20 }, (_, i) => i);
  const out = await loadAll(ids, async (id) => {
    active++; peak = Math.max(peak, active);
    await sleep((id * 7) % 5); active--; return id * 10;
  }, 3);
  assert.deepEqual(out, ids.map((i) => i * 10));
  assert.ok(peak <= 3, 'peak ' + peak);
});
test('rejection propagates', async () => {
  await assert.rejects(loadAll([1, 2, 3], async (id) => { if (id === 2) throw new Error('boom'); return id; }, 2), /boom/);
});
test('empty input', async () => { assert.deepEqual(await loadAll([], async () => 1, 2), []); });
EOF
node --test "$H/hidden.test.mjs"
