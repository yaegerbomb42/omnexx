import unittest

from pipeline import run


class PipelineTest(unittest.TestCase):
    def test_chain(self):
        calls = []
        specs = [{"name": "a"}, {"name": "b", "deps": ["a"]}]
        res = run(specs, {"a": lambda: calls.append("a"), "b": lambda: calls.append("b")})
        self.assertEqual(calls, ["a", "b"])
        self.assertEqual(res["b"], {"status": "ok", "attempts": 1})


if __name__ == "__main__":
    unittest.main()
