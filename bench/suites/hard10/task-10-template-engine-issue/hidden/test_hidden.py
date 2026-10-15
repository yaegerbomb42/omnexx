import copy
import unittest

from tmpl import render


class Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class Hidden(unittest.TestCase):
    def test_filter_args_with_separators(self):
        ctx = {"tags": ["a", "b", "c"], "title": None, "t": "x|y"}
        self.assertEqual(render("{{ tags | join(', ') }}", ctx), "a, b, c")
        self.assertEqual(render('{{ tags | join(" | ") }}', ctx), "a | b | c")
        self.assertEqual(render("{{ title | default('n/a | none') }}", ctx), "n/a | none")
        self.assertEqual(render("{{ missing | default('(none), yet') | upper }}", ctx), "(NONE), YET")
        self.assertEqual(render("{{ t | replace('|', ', ') }}", ctx), "x, y")
        self.assertEqual(render("{{ t | replace(\"|\", 'a,b)') | upper }}", ctx), "XA,B)Y")
        self.assertEqual(render("{{ 'p|q' | replace('|', '') }}", ctx), "pq")
        self.assertEqual(render("{{ tags|join('-')|upper }}", ctx), "A-B-C")
        self.assertEqual(render("{{ tags | length }}", ctx), "3")

    def test_nested_loop_state(self):
        ctx = {"groups": [{"items": [1, 2]}, {"items": [3]}]}
        tpl = ("{% for g in groups %}{% for i in g.items %}{{ i }}{% endfor %}"
               "{% if loop.last %}.{% else %}, {% endif %}{% endfor %}")
        self.assertEqual(render(tpl, ctx), "12, 3.")
        tpl = ("{% for a in xs %}[{{ loop.index }}:{% for b in xs %}{{ loop.index }}{% endfor %}"
               "{{ loop.index }}{% if loop.first %}F{% endif %}]{% endfor %}")
        self.assertEqual(render(tpl, {"xs": [7, 8, 9]}), "[1:1231F][2:1232][3:1233]")

    def test_three_levels(self):
        tpl = ("{% for a in xs %}{% for b in xs %}{% for c in xs %}{% endfor %}{{ loop.index }}"
               "{% endfor %}{{ loop.index }}{{ a }}|{% endfor %}")
        self.assertEqual(render(tpl, {"xs": ["p", "q"]}), "121p|122q|")

    def test_scoping(self):
        self.assertEqual(render("{% for x in xs %}{% endfor %}{{ x }}", {"x": "outer", "xs": [1, 2]}), "outer")
        self.assertEqual(render("{% for y in xs %}{% endfor %}[{{ y }}][{{ loop.index }}]", {"xs": [1, 2]}), "[][]")
        tpl = "{% for x in xs %}{% for x in x %}{{ x }}{% endfor %}-{{ x | length }};{% endfor %}{{ x }}"
        self.assertEqual(render(tpl, {"xs": ["ab", "c"], "x": "!"}), "ab-2;c-1;!")

    def test_ctx_not_mutated(self):
        ctx = {"xs": [1, 2], "x": "keep", "nested": {"k": [1]}}
        snapshot = copy.deepcopy(ctx)
        render("{% for x in xs %}{% for k in nested.k %}{{ k }}{% endfor %}{% endfor %}", ctx)
        self.assertEqual(ctx, snapshot)

    def test_existing_behavior(self):
        ctx = {"user": Obj(name="ada", tags=[]), "n": 0, "items": []}
        self.assertEqual(render("Hi {{ user.name | upper }}!", ctx), "Hi ADA!")
        self.assertEqual(render("{{ user.missing }}|{{ nope.deeper }}|{{ n }}", ctx), "||0")
        self.assertEqual(render("{% if user.tags %}y{% else %}n{% endif %}", ctx), "n")
        self.assertEqual(render("{% for i in items %}x{% endfor %}done", ctx), "done")
        self.assertEqual(render("{{ 'lit' }}{{ \"q\" }}{{ 42 }}", ctx), "litq42")
        self.assertEqual(render("{{ user.name|default('z') }}", ctx), "ada")
        self.assertEqual(render("{% for c in 'abc' %}{% if loop.last %}{{ c }}{% endif %}{% endfor %}", ctx), "c")


if __name__ == "__main__":
    unittest.main()
