"""Topological execution."""
from .executor import attempt
from .graph import build


def run(specs, actions):
    jobs = build(specs)
    results = {}
    pending = dict(jobs)
    while pending:
        ready = [j for j in pending.values() if all(d in results for d in j["deps"])]
        ready.sort(key=lambda j: (j["priority"], j["name"]))
        job = ready[0]
        del pending[job["name"]]
        ok, n = attempt(job, actions[job["name"]])
        results[job["name"]] = {"status": "ok" if ok else "failed", "attempts": n}
    return results
