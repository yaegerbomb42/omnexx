#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/../common.sh"
[[ -d shipping && ! -e shipping.py ]]
py -m unittest discover -s tests >/dev/null 2>&1
hidden_dir
cd "$H"
TASK_REPO="$REPO" PYTHONPATH="$REPO" py -m unittest -q test_hidden
