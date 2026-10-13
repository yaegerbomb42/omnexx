#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "task-09-add-csv-export",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
mkdir -p src
cat > src/export.js << 'EOF'
// TODO: use toCsv from ./csv.js
export function exportUsers(users) {
  throw new Error('not implemented');
}
EOF
