import os
import tempfile
import unittest

from producer.emit import records


class EmitTest(unittest.TestCase):
    def test_v1(self):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as fh:
            fh.write("sensor,timestamp,value,unit\ns1,2024-05-01T00:00:00Z,50,F\ns1,2024-05-01T00:01:00Z,,C\n")
        try:
            self.assertEqual(list(records(fh.name)), [{"sensor": "s1", "ts": 1714521600, "value": 10.0}])
        finally:
            os.unlink(fh.name)


if __name__ == "__main__":
    unittest.main()
