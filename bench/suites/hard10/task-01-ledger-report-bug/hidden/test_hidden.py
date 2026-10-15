"""Hidden checks: behavior through the CLI and the public functions only."""
import os
import subprocess
import sys
import tempfile
import unittest

REPO = os.environ["TASK_REPO"]


def write_csv(rows):
    fh = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False)
    fh.write("timestamp,account,amount,currency\n")
    fh.writelines(",".join(r) + "\n" for r in rows)
    fh.close()
    return fh.name


def run_cli(rows, month):
    path = write_csv(rows)
    try:
        out = subprocess.run([sys.executable, "-m", "ledger", "report", path, month],
                             cwd=REPO, capture_output=True, text=True, check=True).stdout
    finally:
        os.unlink(path)
    return dict(line.split() for line in out.strip().splitlines() if line.strip())


class Hidden(unittest.TestCase):
    def test_exact_cents(self):
        amounts = ["0.10", "0.20", "0.70", "0.10", "0.20", "0.70", "0.33", "0.35"]
        rows = [("2024-03-0%dT10:00:00Z" % (1 + i), "acct", a, "USD") for i, a in enumerate(amounts)]
        self.assertEqual(run_cli(rows, "2024-03")["acct"], "2.68")

    def test_many_dimes(self):
        rows = [("2024-03-05T10:00:00Z", "d", "0.10", "USD")] * 1000
        self.assertEqual(run_cli(rows, "2024-03")["d"], "100.00")

    def test_no_negative_zero(self):
        rows = [("2024-03-05T10:00:00Z", "z", "0.10", "USD"),
                ("2024-03-05T11:00:00Z", "z", "0.20", "USD"),
                ("2024-03-05T12:00:00Z", "z", "-0.30", "USD")]
        self.assertEqual(run_cli(rows, "2024-03")["z"], "0.00")

    def test_round_half_up_only_when_printed(self):
        # 1.005 EUR * 1.10 = 1.1055 each; three of them = 3.3165 -> 3.32
        rows = [("2024-03-05T10:00:00Z", "e", "1.005", "EUR")] * 3
        self.assertEqual(run_cli(rows, "2024-03")["e"], "3.32")
        self.assertEqual(run_cli([("2024-03-05T10:00:00Z", "h", "0.125", "USD")], "2024-03")["h"], "0.13")
        self.assertEqual(run_cli([("2024-03-05T10:00:00Z", "n", "-0.125", "USD")], "2024-03")["n"], "-0.13")

    def test_offsets_bucket_by_utc_month(self):
        rows = [("2024-03-31T23:30:00-02:00", "x", "5", "USD"),   # 2024-04-01T01:30Z
                ("2024-04-01T00:30:00+02:00", "x", "7", "USD"),   # 2024-03-31T22:30Z
                ("2024-03-15T12:00:00Z", "x", "1", "USD"),
                ("2024-03-31T23:59:59+00:00", "x", "2", "USD")]
        self.assertEqual(run_cli(rows, "2024-03")["x"], "10.00")
        self.assertEqual(run_cli(rows, "2024-04")["x"], "5.00")

    def test_year_boundary(self):
        rows = [("2025-01-01T03:00:00+05:00", "y", "4", "USD")]  # 2024-12-31T22:00Z
        self.assertEqual(run_cli(rows, "2024-12")["y"], "4.00")
        self.assertNotIn("y", run_cli(rows, "2025-01"))

    def test_public_api_still_works(self):
        sys.path.insert(0, REPO)
        from ledger.parse import read_entries
        from ledger.report import monthly_totals, render
        path = write_csv([("2024-03-01T00:00:00Z", "a", "0.10", "USD"),
                          ("2024-03-01T00:00:00Z", "a", "0.20", "USD"),
                          ("2024-03-01T00:00:00Z", "b", "100", "JPY")])
        try:
            text = render(monthly_totals(read_entries(path), "2024-03"))
        finally:
            os.unlink(path)
        self.assertEqual(text.splitlines(), ["a\t0.30", "b\t0.67"])


if __name__ == "__main__":
    unittest.main()
