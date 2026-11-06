#!/usr/bin/env bash
set -euo pipefail
if [ -d hidden ]; then
  cp -r hidden/* . 2>/dev/null || true
fi
npx vitest run --project unit 2>&1 | tail -5
exit 0
