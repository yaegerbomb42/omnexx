#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "task-10-long-inventory-system",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
mkdir -p src
cat > src/index.js << 'EOF'
// Inventory library: see the task description.
export {};
EOF
