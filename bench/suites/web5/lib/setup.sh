#!/usr/bin/env bash
# Shared setup for a web5 task, run in the work dir: copies the task's starting repo and writes
# .docs/serve.sh, which serves the task's site (outside the repo) or the repo's public/ folder.
# Usage: setup.sh <taskDir> <port> <site|public>
set -euo pipefail
TASK="$1"
PORT="$2"
MODE="$3"
LIB="$(cd "$(dirname "$0")" && pwd)"

cp -R "$TASK/repo/." .
mkdir -p .docs
if [ "$MODE" = "site" ]; then
  SITE="\"$TASK/site\""
else
  SITE='"$(cd "$(dirname "$0")/.." && pwd)/public"'
fi
cat > .docs/serve.sh << EOF
#!/usr/bin/env bash
# Serves on http://127.0.0.1:$PORT/ until stopped. Run it in the background.
exec node "$LIB/serve.mjs" $SITE $PORT
EOF
chmod +x .docs/serve.sh
