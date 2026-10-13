#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "task-05-implement-lru-cache",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
mkdir -p src
cat > src/lru.js << 'EOF'
export class LRUCache {
  constructor(capacity) {
    throw new Error('not implemented');
  }
}
EOF
