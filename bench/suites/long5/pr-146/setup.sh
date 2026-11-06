#!/usr/bin/env bash
set -euo pipefail
git init -q && git add -A && git -c user.name=bench -c user.email=bench@omnexx.dev commit -qm "bench: pr-146 start" --allow-empty
echo "pr-146 setup: start at parent commit of PR #146"
exit 0
