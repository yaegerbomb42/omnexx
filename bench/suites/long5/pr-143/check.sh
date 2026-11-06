#!/usr/bin/env bash
set -euo pipefail
# Hidden check: PR #143's tests verify think-first loop sessions
# Restore hidden tests from hidden/ before running (agent can't edit them)
if [ -d hidden ]; then
  cp -r hidden/* . 2>/dev/null || true
fi
# Run the repo's test suite (hidden tests included)
npx vitest run --project unit 2>&1 | tail -5
exit 0
