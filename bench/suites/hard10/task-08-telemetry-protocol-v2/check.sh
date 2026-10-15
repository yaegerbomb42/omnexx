#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/../common.sh"
npm test >/dev/null 2>&1
hidden_dir
TASK_REPO="$REPO" node --test "$H/hidden.test.mjs"
