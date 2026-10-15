# Task: Fix Issue #87, "Filter arguments and nested loops render wrong output"

> **Issue #87**
>
> Three problems we hit while porting our email templates:
>
> 1. `{{ tags | join(', ') }}` renders `a'b'c` style garbage or crashes, and
>    `{{ title | default('n/a | none') }}` fails with a `KeyError`. Filter arguments containing
>    `,` or `|` (or `(`/`)`) inside quotes are mangled.
> 2. In nested loops, `loop.last` / `loop.index` of the _outer_ loop are wrong after the inner
>    loop has run:
>    `{% for g in groups %}{% for i in g.items %}{{ i }}{% endfor %}{% if loop.last %}.{% else %}, {% endif %}{% endfor %}`
>    with `groups = [{"items": [1, 2]}, {"items": [3]}]` prints `12.3.` instead of `12, 3.`.
> 3. Loop variables leak and clobber outer names: with `{"x": "outer"}`,
>    `{% for x in xs %}{% endfor %}{{ x }}` prints the last item instead of `outer`; and a
>    variable that did not exist before the loop is still defined afterwards.
>
> Expected: the semantics in the README.

Fix the engine (the problems span more than one module), keep `tmpl.render(src, ctx)` and
everything that works today working, and do not mutate the caller's `ctx`. Add regression tests.

## Success Criteria

- `python3 -m unittest discover -s tests` passes
- All three reported problems are fixed per the README semantics, for any combination of quotes,
  commas, pipes and parentheses inside string literal arguments, and any loop nesting depth
