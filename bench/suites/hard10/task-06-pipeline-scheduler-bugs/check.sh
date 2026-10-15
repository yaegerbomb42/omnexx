#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/../common.sh"
py -m unittest discover -s tests >/dev/null 2>&1
hidden_dir
cd "$H"
PYTHONPATH="$REPO" py -m unittest -q test_hidden
