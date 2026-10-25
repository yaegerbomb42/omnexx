import json, os, subprocess

RUNS = {
    "mwaskom__seaborn-3190": {
        "runId": "r_20261022_1219_0d49",
        "repo": "/private/tmp/swebench_work/mwaskom__seaborn-3190",
        "start": "4a9e54962a29c12a8b103d75f838e0e795a6974d",
        "lastGreen": "d760af6667dc1491a5666e6f843c21e3031c1ae9"
    },
    "pallets__flask-4992": {
        "runId": "r_20261022_1234_8933",
        "repo": "/private/tmp/swebench_work/pallets__flask-4992",
        "start": "4c288bc97ea371817199908d0d9b12de9dae327e",
        "lastGreen": "3c1e1c7638845bfc8f98fe1fe043f414cdf9faaa"
    },
    "psf__requests-2674": {
        "runId": "r_20261022_1249_2c45",
        "repo": "/private/tmp/swebench_work/psf__requests-2674",
        "start": "0be38a0c37c59c4b66ce908731da15b401655113",
        "lastGreen": "c629921d8eda64ec08747793720c2a3dda7259d8"
    }
}

OUTDIR = "/Users/yaeger/Projects/omnexx/bench/results/swebench_pilot"
predictions = []

for inst_id, info in RUNS.items():
    repo = info["repo"]
    start = info["start"]
    green = info["lastGreen"]
    diff_p = subprocess.run(["git", "diff", f"{start}..{green}"], cwd=repo, capture_output=True, text=True)
    patch = diff_p.stdout
    print(f"[{inst_id}] Diff from {start[:8]}..{green[:8]}: {len(patch)} chars")
    
    # Save individual patch file
    with open(os.path.join(OUTDIR, f"{inst_id}.patch"), "w") as f:
        f.write(patch)
        
    predictions.append({
        "instance_id": inst_id,
        "model_patch": patch,
        "model_name_or_path": "omnexx-mercury-3-extreme"
    })

pred_file = os.path.join(OUTDIR, "predictions.jsonl")
with open(pred_file, "w") as pf:
    for p in predictions:
        pf.write(json.dumps(p) + "\n")

print(f"Updated predictions.jsonl with real git patches!")
