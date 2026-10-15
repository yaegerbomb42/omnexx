"""Render a node tree against a context."""
from .expr import evaluate
from .lexer import tokenize
from .parser import parse


def render(src, ctx):
    return "".join(_render(parse(tokenize(src)), dict(ctx)))


def _render(nodes, ctx):
    for node in nodes:
        kind = node[0]
        if kind == "text":
            yield node[1]
        elif kind == "out":
            value = evaluate(node[1], ctx)
            yield "" if value is None else str(value)
        elif kind == "if":
            _, cond, then, other = node
            yield from _render(then if evaluate(cond, ctx) else other, ctx)
        elif kind == "for":
            _, var, expr, body = node
            items = list(evaluate(expr, ctx) or [])
            for i, item in enumerate(items):
                ctx[var] = item
                ctx["loop"] = {"index": i + 1, "first": i == 0, "last": i == len(items) - 1}
                yield from _render(body, ctx)
