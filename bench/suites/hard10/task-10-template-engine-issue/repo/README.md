# tmpl

A tiny Jinja-like template engine (stdlib only). Tests: `python3 -m unittest discover -s tests`.

```python
from tmpl import render
render("Hi {{ user.name | upper }}!", {"user": {"name": "ada"}})  # "Hi ADA!"
```

Syntax:

- `{{ expr }}` prints a value; `None` and undefined names print as empty text.
- `expr` is a literal (`'text'`, `"text"`, an integer) or a dotted name (`a.b.c`, looked up as a
  dict key, then as an attribute), followed by any number of filters: `| name` or
  `| name(arg, ...)` where each arg is a literal.
- Filters: `upper`, `lower`, `length`, `join(sep)`, `default(value)` (used when the value is
  undefined, `None` or `''`), `replace(old, new)`.
- `{% for x in expr %}...{% endfor %}` loops; inside, `loop.index` (from 1), `loop.first` and
  `loop.last` describe the innermost loop. Loop variables are scoped to the loop body.
- `{% if expr %}...{% else %}...{% endif %}` (`else` optional), Python truthiness.
