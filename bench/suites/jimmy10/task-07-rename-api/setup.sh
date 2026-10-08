#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "task-07-rename-api",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
mkdir -p src
cat > src/usr.js << 'EOF'
const USERS = { 1: { id: 1, name: 'Ada' }, 2: { id: 2, name: 'Linus' } };
export function getUsr(id) {
  return USERS[id] ?? null;
}
EOF
mkdir -p src
cat > src/greet.js << 'EOF'
import { getUsr } from './usr.js';
export function greet(id) {
  const u = getUsr(id);
  return u ? `Hello, ${u.name}` : 'Hello, stranger';
}
EOF
mkdir -p src
cat > src/report.js << 'EOF'
import { getUsr } from './usr.js';
export function names(ids) {
  return ids.map((id) => getUsr(id)?.name ?? '?').join(', ');
}
EOF
mkdir -p test
cat > test/greet.test.js << 'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';
import { getUsr } from '../src/usr.js';
test('greets', () => { assert.equal(greet(1), 'Hello, Ada'); assert.equal(getUsr(9), null); });
EOF
