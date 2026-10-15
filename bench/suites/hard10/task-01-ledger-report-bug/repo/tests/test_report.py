import unittest

from ledger.money import to_amount
from ledger.parse import Entry
from ledger.report import monthly_totals, render


class ReportTest(unittest.TestCase):
    def test_sums_one_account(self):
        es = [Entry("2024-03-02T10:00:00Z", "cash", to_amount("5.00"), "USD"),
              Entry("2024-03-03T10:00:00Z", "cash", to_amount("2.50"), "USD")]
        self.assertEqual(render(monthly_totals(es, "2024-03")), "cash\t7.50")


if __name__ == "__main__":
    unittest.main()
