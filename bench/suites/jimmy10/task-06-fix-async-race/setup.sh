#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "task-06-fix-async-race",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
mkdir -p src
cat > src/loader.js << 'EOF'
/** Fetch all ids with at most `limit` concurrent calls to `fetchOne`. */
export async function loadAll(ids, fetchOne, limit) {
  const results = [];
  let active = 0;
  await Promise.all(
    ids.map(async (id) => {
      while (active > limit) await new Promise((r) => setTimeout(r, 1));
      active++;
      results.push(await fetchOne(id));
      active--;
    }),
  );
  return results;
}
EOF
