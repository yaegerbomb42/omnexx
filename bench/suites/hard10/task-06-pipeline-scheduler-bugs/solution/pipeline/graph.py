"""Job graph construction and validation."""


class CycleError(ValueError):
    pass


def build(specs):
    """{name: spec} after validating names and deps."""
    jobs = {}
    for s in specs:
        if s["name"] in jobs:
            raise ValueError("duplicate job " + s["name"])
        jobs[s["name"]] = {"name": s["name"], "deps": list(s.get("deps", [])),
                           "priority": s.get("priority", 0), "max_retries": s.get("max_retries", 0)}
    for j in jobs.values():
        for d in j["deps"]:
            if d not in jobs:
                raise ValueError(f"job {j['name']} depends on unknown job {d}")
    check_acyclic(jobs)
    return jobs


def check_acyclic(jobs):
    done = set()

    def visit(name, path):
        if name in path:
            cycle = path[path.index(name):] + [name]
            raise CycleError("cycle: " + " -> ".join(cycle))
        if name in done:
            return
        for d in jobs[name]["deps"]:
            visit(d, path + [name])
        done.add(name)

    for name in sorted(jobs):
        visit(name, [])
