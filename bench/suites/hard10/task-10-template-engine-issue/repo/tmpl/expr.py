"""Expressions: a literal or dotted name, then filters."""
from .filters import FILTERS


class Undefined:
    def __str__(self):
        return ""

    def __bool__(self):
        return False


UNDEFINED = Undefined()


def literal(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        return True, text[1:-1]
    if text.lstrip("-").isdigit():
        return True, int(text)
    return False, None


def lookup(ctx, dotted):
    cur = ctx
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif hasattr(cur, part) and not isinstance(cur, dict):
            cur = getattr(cur, part)
        else:
            return UNDEFINED
    return cur


def parse_filter(text):
    text = text.strip()
    if "(" not in text:
        return text, []
    name, rest = text.split("(", 1)
    args = [literal(a)[1] for a in rest.rstrip(")").split(",") if a.strip()]
    return name.strip(), args


def evaluate(src, ctx):
    head, *filters = src.split("|")
    is_lit, value = literal(head)
    if not is_lit:
        value = lookup(ctx, head.strip())
    for f in filters:
        name, args = parse_filter(f)
        value = FILTERS[name](value, *args)
    return value
