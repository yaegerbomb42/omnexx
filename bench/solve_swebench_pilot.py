import json, os, subprocess

MANIFEST = "/Users/yaeger/Projects/omnexx/bench/results/swebench_pilot/pilot_manifest.json"
OUTDIR = "/Users/yaeger/Projects/omnexx/bench/results/swebench_pilot"
WORKROOT = "/tmp/swebench_work"

with open(MANIFEST) as f:
    items = json.load(f)

predictions = []

for item in items:
    inst_id = item['instance_id']
    work_dir = os.path.join(WORKROOT, inst_id)
    goal = f"""SWE-bench Task: {inst_id}
Problem Description:
{item['problem_statement']}

Requirement:
Fix the issue described above. Ensure all relevant tests in the repo pass without regressions.
"""
    goal_file = os.path.join(work_dir, "SWE_GOAL.md")
    with open(goal_file, "w") as gf:
        gf.write(goal)

    print(f"[{inst_id}] Running Omnexx in Extreme Mode...")
    cmd = [
        "node", "/Users/yaeger/Projects/omnexx/dist/cli.js", "run",
        "--goal-file", goal_file,
        "--hours", "0.25",
        "--budget", "2",
        "--push", "none"
    ]
    env = os.environ.copy()
    env["OMNEXX_EXECUTION_MODE"] = "extreme"
    try:
        p = subprocess.run(cmd, cwd=work_dir, env=env, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        print(f"[{inst_id}] Omnexx timed out.")

    # Check worktree commit history to ensure we pick up worktree commits
    patch = ""
    # Check if a worktree was created in ~/.omnexx/worktrees
    wt_p = subprocess.run(["find", os.path.expanduser("~/.omnexx/worktrees"), "-maxdepth", "1", "-name", f"{inst_id}*"], capture_output=True, text=True)
    wts = wt_p.stdout.strip().split("\n") if wt_p.stdout.strip() else []
    if wts and os.path.exists(wts[-1]):
        active_wt = wts[-1]
        print(f"[{inst_id}] Found worktree at {active_wt}")
        diff_p = subprocess.run(["git", "diff", f"{item['base_commit']}..HEAD"], cwd=active_wt, capture_output=True, text=True)
        patch = diff_p.stdout

    if not patch:
        diff_p = subprocess.run(["git", "diff", item["base_commit"]], cwd=work_dir, capture_output=True, text=True)
        patch = diff_p.stdout

    print(f"[{inst_id}] Generated patch length: {len(patch)} chars")
    predictions.append({
        "instance_id": inst_id,
        "model_patch": patch,
        "model_name_or_path": "omnexx-mercury-3-extreme"
    })

pred_file = os.path.join(OUTDIR, "predictions.jsonl")
with open(pred_file, "w") as pf:
    for pred in predictions:
        pf.write(json.dumps(pred) + "\n")

print(f"=== SWE-bench Pilot Predictions written to {pred_file} ===")
