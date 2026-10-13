#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "task-04-fix-pagination-bug",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
mkdir -p src
cat > src/paginate.js << 'EOF'
/** Return one 1-based page of `items` plus the total page count. */
export function paginate(items, page, pageSize) {
  const totalPages = Math.floor(items.length / pageSize);
  const start = page * pageSize;
  return { items: items.slice(start, start + pageSize + 1), page, totalPages };
}
EOF
mkdir -p test
cat > test/paginate.test.js << 'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';
test('first page of an even split', () => {
  assert.equal(paginate([1, 2, 3, 4], 1, 2).totalPages, 2);
});
EOF
