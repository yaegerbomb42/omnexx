#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/../common.sh"
copy_repo
npm install --no-audit --no-fund --loglevel=error >/dev/null
