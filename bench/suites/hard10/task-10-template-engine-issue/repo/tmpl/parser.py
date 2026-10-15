"""Tokens -> a tree of nodes."""


def parse(tokens):
    body, pos = _block(tokens, 0, ())
    if pos != len(tokens):
        raise SyntaxError("unexpected " + tokens[pos][1])
    return body


def _block(tokens, pos, stop):
    nodes = []
    while pos < len(tokens):
        kind, val = tokens[pos]
        if kind == "tag" and val.split()[0] in stop:
            return nodes, pos
        if kind == "tag":
            node, pos = _tag(tokens, pos, val)
            nodes.append(node)
            continue
        nodes.append((kind, val))
        pos += 1
    if stop:
        raise SyntaxError("missing " + "/".join(stop))
    return nodes, pos


def _tag(tokens, pos, val):
    word = val.split()[0]
    if word == "for":
        _, var, kw, expr = val.split(None, 3)
        if kw != "in":
            raise SyntaxError("bad for: " + val)
        body, pos = _block(tokens, pos + 1, ("endfor",))
        return ("for", var, expr, body), pos + 1
    if word == "if":
        cond = val[2:].strip()
        then, pos = _block(tokens, pos + 1, ("else", "endif"))
        other = []
        if tokens[pos][1] == "else":
            other, pos = _block(tokens, pos + 1, ("endif",))
        return ("if", cond, then, other), pos + 1
    raise SyntaxError("unknown tag " + word)
