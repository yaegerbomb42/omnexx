# Sourced by every hard10 setup.sh / check.sh (not executable on its own).
# TASK_DIR is the sourcing task's suite directory; REPO is the work dir (the cwd).
TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
REPO="$PWD"
export npm_config_cache="${npm_config_cache:-${TMPDIR:-/tmp}/omnexx-bench-npm-cache}"

# setup: copy the task's starting repo into the work dir.
copy_repo() { cp -R "$TASK_DIR/repo/." "$REPO/"; }

# check: copy the hidden tests to a private temp dir (H), removed on exit.
hidden_dir() {
  H="$(mktemp -d)"
  trap 'rm -rf "$H"' EXIT
  cp -R "$TASK_DIR/hidden/." "$H/"
}

# python without bytecode litter or the user's site-packages.
py() { PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 python3 "$@"; }
