#!/usr/bin/env bash
set -euo pipefail
TASK="$(cd "$(dirname "$0")" && pwd)"
bash "$TASK/../lib/setup.sh" "$TASK" 4804 site
