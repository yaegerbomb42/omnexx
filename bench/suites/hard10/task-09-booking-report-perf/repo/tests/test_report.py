import unittest

from rooms.report import peak_report


def b(i, room, start, end):
    return {"id": str(i), "room": room, "start": start, "end": end}


class ReportTest(unittest.TestCase):
    def test_overlap(self):
        r = peak_report([b(1, "A", 0, 10), b(2, "A", 5, 15), b(2, "A", 5, 15), b(3, "A", 15, 20)], {})
        self.assertEqual(r["A"], {"peak": 2, "overbooked": [[5, 10]]})


if __name__ == "__main__":
    unittest.main()
