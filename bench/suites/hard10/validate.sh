#!/usr/bin/env bash
# Validate hard10 tasks: for each, set up a fresh work dir, expect the hidden check to FAIL on the
# starting repo, overlay solution/, and expect it to PASS.
# Usage: bench/suites/hard10/validate.sh [task-dir ...]   (default: all tasks)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ $# -eq 0 ]]; then
  set -- $(cd "$HERE" && ls -d task-*/)
fi
rc=0
for t in "$@"; do
  t="${t%/}"
  W="$(mktemp -d)/work"
  mkdir -p "$W"
  if ! (cd "$W" && bash "$HERE/$t/setup.sh" >/dev/null 2>&1); then
    echo "SETUP-FAIL    $t"; rc=1; continue
  fi
  if (cd "$W" && bash "$HERE/$t/check.sh" >/dev/null 2>&1); then
    echo "STARTS-SOLVED $t"; rc=1; continue
  fi
  cp -R "$HERE/$t/solution/." "$W/"
  # solution/.delete lists paths the reference solution removes.
  if [[ -f "$W/.delete" ]]; then
    while IFS= read -r p; do [[ -n "$p" ]] && rm -rf "${W:?}/$p"; done <"$W/.delete"
    rm -f "$W/.delete"
  fi
  if (cd "$W" && bash "$HERE/$t/check.sh" >"$W/../check.log" 2>&1); then
    echo "ok            $t"
    rm -rf "$(dirname "$W")"
  else
    echo "REF-FAIL      $t (log: $W/../check.log)"; rc=1
  fi
done
exit $rc
