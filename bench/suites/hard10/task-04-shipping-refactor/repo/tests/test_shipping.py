import unittest

from shipping import quote


def order(**kw):
    base = {"weight_kg": 1.0, "dims_cm": [10, 10, 10], "dest": "US", "express": False,
            "items": [{"sku": "a", "qty": 1, "hazmat": False}], "coupon": None, "member": False}
    base.update(kw)
    return base


class ShippingTest(unittest.TestCase):
    def test_postal(self):
        self.assertEqual(quote(order())["carrier"], "postal")

    def test_air_eu(self):
        q = quote(order(dest="FR"))
        self.assertEqual((q["carrier"], q["eta_days"]), ("air", 3))

    def test_hazmat_air_abroad(self):
        with self.assertRaises(ValueError):
            quote(order(dest="FR", items=[{"sku": "x", "qty": 1, "hazmat": True}]))


if __name__ == "__main__":
    unittest.main()
