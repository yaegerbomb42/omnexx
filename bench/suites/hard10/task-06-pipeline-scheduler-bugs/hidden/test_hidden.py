import itertools
import random
import unittest

from pipeline import CycleError, run


def recorder(names, fail=None):
    """actions that log calls; fail maps name -> number of initial failing calls (or True)."""
    fail = fail or {}
    calls = []
    counts = {n: 0 for n in names}

    def make(n):
        def act():
            counts[n] += 1
            calls.append(n)
            f = fail.get(n, 0)
            if f is True or counts[n] <= f:
                raise RuntimeError(n + " failed")
        return act

    return calls, {n: make(n) for n in names}


class Hidden(unittest.TestCase):
    def test_diamond(self):
        specs = [{"name": "deps"}, {"name": "lint", "deps": ["deps"]},
                 {"name": "test", "deps": ["deps"]}, {"name": "package", "deps": ["lint", "test"]}]
        calls, actions = recorder([s["name"] for s in specs])
        res = run(specs, actions)
        self.assertEqual(calls, ["deps", "lint", "test", "package"])
        self.assertTrue(all(r == {"status": "ok", "attempts": 1} for r in res.values()))

    def test_real_cycles_rejected(self):
        for specs in ([{"name": "a", "deps": ["b"]}, {"name": "b", "deps": ["c"]}, {"name": "c", "deps": ["a"]}],
                      [{"name": "x", "deps": ["x"]}],
                      [{"name": "r"}, {"name": "a", "deps": ["r", "b"]}, {"name": "b", "deps": ["a"]}]):
            names = [s["name"] for s in specs]
            with self.assertRaises(CycleError) as ctx:
                run(specs, recorder(names)[1])
            self.assertIsInstance(ctx.exception, ValueError)
        msg = str(ctx.exception)
        self.assertIn("a", msg)
        self.assertIn("b", msg)

    def test_unknown_dep(self):
        with self.assertRaises(ValueError):
            run([{"name": "a", "deps": ["ghost"]}], {"a": lambda: None})

    def test_failed_dep_skips_transitively(self):
        specs = [{"name": "build"}, {"name": "upload", "deps": ["build"]},
                 {"name": "notify", "deps": ["upload"]}, {"name": "audit", "deps": ["notify", "build"]},
                 {"name": "docs", "deps": ["build"]}]
        calls, actions = recorder([s["name"] for s in specs], fail={"upload": True})
        res = run(specs, actions)
        self.assertNotIn("notify", calls)
        self.assertNotIn("audit", calls)
        self.assertEqual(res["upload"], {"status": "failed", "attempts": 1})
        self.assertEqual(res["notify"], {"status": "skipped", "attempts": 0})
        self.assertEqual(res["audit"], {"status": "skipped", "attempts": 0})
        self.assertEqual(res["docs"]["status"], "ok")

    def test_retries(self):
        specs = [{"name": "flaky", "max_retries": 2}, {"name": "after", "deps": ["flaky"]},
                 {"name": "never", "max_retries": 2}, {"name": "once"}, {"name": "one_retry", "max_retries": 1}]
        calls, actions = recorder([s["name"] for s in specs],
                                  fail={"flaky": 2, "never": True, "once": 1, "one_retry": 1})
        res = run(specs, actions)
        self.assertEqual(res["flaky"], {"status": "ok", "attempts": 3})
        self.assertEqual(res["after"], {"status": "ok", "attempts": 1})
        self.assertEqual(res["never"], {"status": "failed", "attempts": 3})
        self.assertEqual(res["once"], {"status": "failed", "attempts": 1})
        self.assertEqual(res["one_retry"], {"status": "ok", "attempts": 2})
        self.assertEqual(calls.count("never"), 3)

    def test_priority_then_name(self):
        specs = [{"name": "root"}, {"name": "b", "deps": ["root"]}, {"name": "a", "deps": ["root"]},
                 {"name": "urgent", "deps": ["root"], "priority": 10}, {"name": "low", "priority": -1},
                 {"name": "z", "priority": 10}]
        calls, actions = recorder([s["name"] for s in specs])
        run(specs, actions)
        self.assertEqual(calls, ["z", "root", "urgent", "a", "b", "low"])

    def test_random_dags_respect_order_and_failures(self):
        rng = random.Random(42)
        for _ in range(150):
            n = rng.randint(1, 9)
            names = ["j%d" % i for i in range(n)]
            specs = [{"name": nm, "deps": [names[k] for k in range(i) if rng.random() < 0.3],
                      "priority": rng.randint(-2, 2), "max_retries": rng.randint(0, 2)}
                     for i, nm in enumerate(names)]
            rng.shuffle(specs)
            fail = {nm: rng.choice([0, 0, 1, 2, 3, True]) for nm in names}
            calls, actions = recorder(names, fail)
            res = run(specs, actions)
            by = {s["name"]: s for s in specs}
            for nm in names:
                s, r = by[nm], res[nm]
                dep_ok = all(res[d]["status"] == "ok" for d in s["deps"])
                if not dep_ok:
                    self.assertEqual(r, {"status": "skipped", "attempts": 0})
                    self.assertNotIn(nm, calls)
                    continue
                f = fail[nm]
                need = 10**9 if f is True else f + 1
                if need <= 1 + s["max_retries"]:
                    self.assertEqual(r, {"status": "ok", "attempts": need})
                else:
                    self.assertEqual(r, {"status": "failed", "attempts": 1 + s["max_retries"]})
            first = {nm: calls.index(nm) for nm in set(calls)}
            for nm in first:
                for d in by[nm]["deps"]:
                    self.assertLess(first[d], first[nm])


if __name__ == "__main__":
    unittest.main()
