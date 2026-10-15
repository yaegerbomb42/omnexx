"""Hidden checks: equivalence with the original on random orders, drone rules, structure."""
import ast
import copy
import os
import pathlib
import random
import unittest

import legacy_shipping
from shipping import quote

REPO = pathlib.Path(os.environ["TASK_REPO"])
DESTS = ["US"] * 6 + ["DE", "FR", "SE", "GB", "JP", "BR", "AU", "NZ", "IS", "CL", "CA"]
COUPONS = [None, None, None, "", "FREESHIP", " freeship ", "HALFAIR", "halfair", "BOGUS"]


def random_order(rng):
    items = [{"sku": "s%d" % i, "qty": rng.choice([0, 1, 1, 2]), "hazmat": rng.random() < 0.15}
             for i in range(rng.randint(0, 3))]
    return {
        "weight_kg": rng.choice([0, -1, round(rng.uniform(0.05, 45), 2), round(rng.uniform(0.05, 6), 2)]),
        "dims_cm": [rng.randint(1, 80) for _ in range(3)],
        "dest": rng.choice(DESTS),
        "express": rng.random() < 0.3,
        "items": items,
        "coupon": rng.choice(COUPONS),
        "member": rng.random() < 0.4,
    }


def outcome(fn, order):
    try:
        return ("ok", fn(copy.deepcopy(order)))
    except ValueError as e:
        return ("error", str(e))


def domestic(**kw):
    base = {"weight_kg": 1.0, "dims_cm": [10, 10, 10], "dest": "US", "express": False,
            "items": [{"sku": "a", "qty": 1, "hazmat": False}], "coupon": None, "member": False,
            "drone_ok": True}
    base.update(kw)
    return base


class Equivalence(unittest.TestCase):
    def test_matches_original_on_random_orders(self):
        rng = random.Random(20261014)
        for _ in range(4000):
            o = random_order(rng)
            if rng.random() < 0.2:
                o["drone_ok"] = False
            self.assertEqual(outcome(quote, o), outcome(legacy_shipping.quote, o), o)

    def test_repeat_calls_do_not_leak_state(self):
        a = domestic(drone_ok=False, coupon="FREESHIP")
        first = quote(a)
        quote(domestic(drone_ok=False, items=[{"sku": "h", "qty": 1, "hazmat": True}]))
        self.assertEqual(quote(a), first)

    def test_ineligible_drone_orders_unchanged(self):
        rng = random.Random(7)
        for _ in range(1500):
            o = random_order(rng)
            o["drone_ok"] = True
            hazmat = any(i["hazmat"] and i["qty"] > 0 for i in o["items"])
            if o["dest"] == "US" and not o["express"] and not hazmat and o["weight_kg"] > 0:
                o["weight_kg"] = round(rng.uniform(5.6, 25), 2)  # billable > 5 kg
            self.assertEqual(outcome(quote, o), outcome(legacy_shipping.quote, o), o)


class Drone(unittest.TestCase):
    def test_basic_drone(self):
        q = quote(domestic(weight_kg=2.2))  # billable 2.5
        self.assertEqual((q["carrier"], q["eta_days"], q["cost_cents"]), ("drone", 0, 900 + 375))

    def test_dimensional_weight_counts(self):
        q = quote(domestic(weight_kg=1.0, dims_cm=[40, 30, 20]))  # dim 4.8 -> 5.0
        self.assertEqual((q["carrier"], q["cost_cents"]), ("drone", 1650))
        self.assertIn("dimensional weight applied", q["notes"])
        q = quote(domestic(weight_kg=1.0, dims_cm=[50, 30, 20]))  # dim 6.0 -> not drone
        self.assertNotEqual(q["carrier"], "drone")

    def test_boundaries(self):
        self.assertEqual(quote(domestic(weight_kg=5.0))["carrier"], "drone")
        self.assertNotEqual(quote(domestic(weight_kg=5.01))["carrier"], "drone")
        self.assertEqual(quote(domestic(weight_kg=0.1))["cost_cents"], 900 + 75)

    def test_ineligible(self):
        self.assertEqual(quote(domestic(express=True))["carrier"], "air")
        self.assertEqual(quote(domestic(dest="DE"))["carrier"], "air")
        self.assertEqual(quote(domestic(items=[{"sku": "h", "qty": 1, "hazmat": True}]))["carrier"], "ground")
        self.assertEqual(quote(domestic(drone_ok=False))["carrier"], "postal")

    def test_coupons_and_member(self):
        q = quote(domestic(weight_kg=1.0, coupon="FREESHIP"))
        self.assertEqual(q["cost_cents"], 1050)
        self.assertEqual(q["notes"], ["coupon FREESHIP not applicable"])
        q = quote(domestic(weight_kg=1.0, coupon="halfair", member=True))
        self.assertEqual(q["cost_cents"], round(1050 * 0.9))
        self.assertEqual(q["notes"], ["coupon HALFAIR not applicable", "member discount"])
        self.assertEqual(quote(domestic(weight_kg=1.0, member=True))["notes"], ["member discount"])

    def test_zero_qty_hazmat_ignored(self):
        q = quote(domestic(items=[{"sku": "h", "qty": 0, "hazmat": True}]))
        self.assertEqual(q["carrier"], "drone")


class Structure(unittest.TestCase):
    def files(self):
        return sorted((REPO / "shipping").rglob("*.py"))

    def test_package_layout(self):
        self.assertTrue((REPO / "shipping" / "__init__.py").exists())
        self.assertGreaterEqual(len(self.files()), 3, "split into modules")

    def test_function_length(self):
        for path in self.files():
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    length = node.end_lineno - node.lineno + 1
                    self.assertLessEqual(length, 40, f"{path.name}:{node.name} is {length} lines")

    def test_no_module_level_mutable_containers_mutated(self):
        for path in self.files():
            tree = ast.parse(path.read_text())
            for node in tree.body:
                targets = node.targets if isinstance(node, ast.Assign) else []
                if isinstance(node, ast.AnnAssign):
                    targets = [node.target]
                value = getattr(node, "value", None)
                if isinstance(value, (ast.Dict, ast.DictComp)) or (
                        isinstance(value, ast.Call) and getattr(value.func, "id", "") in ("dict", "defaultdict")):
                    for t in targets:
                        name = getattr(t, "id", "")
                        self.assertFalse("cache" in name.lower(), f"{path.name}: module-level {name}")


if __name__ == "__main__":
    unittest.main()
