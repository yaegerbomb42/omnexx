import unittest

from tmpl import render


class RenderTest(unittest.TestCase):
    def test_filters(self):
        self.assertEqual(render("Hi {{ user.name | upper }}!", {"user": {"name": "ada"}}), "Hi ADA!")

    def test_loop(self):
        self.assertEqual(render("{% for x in xs %}{{ loop.index }}{{ x }} {% endfor %}", {"xs": "ab"}), "1a 2b ")


if __name__ == "__main__":
    unittest.main()
