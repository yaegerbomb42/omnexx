#!/usr/bin/env bash
set -euo pipefail
git init -q && git add -A && git -c user.name=bench -c user.email=bench@omnexx.dev commit -qm "bench: pr-147 start" --allow-empty
echo "pr-147 setup: start at parent commit of PR #147"
exit 0
