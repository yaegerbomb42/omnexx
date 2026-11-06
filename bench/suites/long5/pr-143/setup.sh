#!/usr/bin/env bash
set -euo pipefail
# Long task PR #143: start at parent commit 12cba2c
git init -q && git add -A && git -c user.name=bench -c user.email=bench@omnexx.dev commit -qm "bench: pr-143 start" --allow-empty
# In a real run, checkout the parent commit: git checkout 12cba2cb64961dd941eb5a36891e272216d23efb
# Copy PR's test files into hidden/ (restored before check)
echo "pr-143 setup: start at parent commit of PR #143"
exit 0
