#!/usr/bin/env python3
"""Extract real git patches from SWE-bench pilot runs into predictions.jsonl.

Fails loudly: a failing or empty `git diff` never produces an empty
predictions entry, and the script exits nonzero when no patch was extracted.

Overrides (env, or CLI flag wins over env):
  OMNEXX_PILOT_OUTDIR / --outdir   where patches and predictions.jsonl go
  OMNEXX_PILOT_RUNS   / --runs     JSON file mapping instance_id ->
                                   {runId, repo, start, lastGreen}
"""

import json
import os
import subprocess
import sys

DEFAULT_RUNS = {
    "mwaskom__seaborn-3190": {
        "runId": "r_20261022_1219_0d49",
        "repo": "/private/tmp/swebench_work/mwaskom__seaborn-3190",
        "start": "4a9e54962a29c12a8b103d75f838e0e795a6974d",
        "lastGreen": "d760af6667dc1491a5666e6f843c21e3031c1ae9",
    },
    "pallets__flask-4992": {
        "runId": "r_20261022_1234_8933",
        "repo": "/private/tmp/swebench_work/pallets__flask-4992",
        "start": "4c288bc97ea371817199908d0d9b12de9dae327e",
        "lastGreen": "3c1e1c7638845bfc8f98fe1fe043f414cdf9faaa",
    },
    "psf__requests-2674": {
        "runId": "r_20261022_1249_2c45",
        "repo": "/private/tmp/swebench_work/psf__requests-2674",
        "start": "0be38a0c37c59c4b66ce908731da15b401655113",
        "lastGreen": "c629921d8eda64ec08747793720c2a3dda7259d8",
    },
}

DEFAULT_OUTDIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "bench",
    "results",
    "swebench_pilot",
)
MODEL = "omnexx-mercury-3-extreme"


def run_git(args, cwd):
    """Run a git command, returning (returncode, stdout)."""
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    return proc.returncode, proc.stdout


def load_runs(path=None):
    if path:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return DEFAULT_RUNS


def extract(runs, outdir, model=MODEL):
    """Write per-instance .patch files and predictions.jsonl into outdir.

    Instances whose `git diff` fails or comes back empty are reported on
    stderr and skipped, so predictions.jsonl never holds an empty entry.
    Returns the list of predictions actually written.
    """
    os.makedirs(outdir, exist_ok=True)
    predictions = []
    for inst_id, info in runs.items():
        repo = info["repo"]
        start = info["start"]
        green = info["lastGreen"]
        code, patch = run_git(["git", "diff", f"{start}..{green}"], repo)
        if code != 0:
            print(f"[{inst_id}] git diff {start[:8]}..{green[:8]} failed (rc={code}) in {repo}", file=sys.stderr)
            continue
        if not patch.strip():
            print(f"[{inst_id}] git diff {start[:8]}..{green[:8]} produced an empty patch", file=sys.stderr)
            continue
        print(f"[{inst_id}] Diff from {start[:8]}..{green[:8]}: {len(patch)} chars")
        with open(os.path.join(outdir, f"{inst_id}.patch"), "w", encoding="utf-8") as f:
            f.write(patch)
        predictions.append(
            {
                "instance_id": inst_id,
                "model_patch": patch,
                "model_name_or_path": model,
            }
        )

    pred_file = os.path.join(outdir, "predictions.jsonl")
    with open(pred_file, "w", encoding="utf-8") as pf:
        for p in predictions:
            pf.write(json.dumps(p) + "\n")
    return predictions


def _opt(argv, flag, env_value, default):
    if flag in argv:
        i = argv.index(flag)
        if i + 1 < len(argv):
            return argv[i + 1]
    return env_value if env_value else default


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    outdir = _opt(argv, "--outdir", os.environ.get("OMNEXX_PILOT_OUTDIR"), DEFAULT_OUTDIR)
    runs = load_runs(_opt(argv, "--runs", os.environ.get("OMNEXX_PILOT_RUNS"), None))

    predictions = extract(runs, outdir)
    if not predictions:
        print("extract_real_patches: no patches produced", file=sys.stderr)
        return 1
    print(f"Updated {os.path.join(outdir, 'predictions.jsonl')} with {len(predictions)} real git patches")
    return 0


if __name__ == "__main__":
    sys.exit(main())
