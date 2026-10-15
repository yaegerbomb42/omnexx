"""Split a template into text, {{ output }} and {% tag %} tokens."""
import re

TOKEN = re.compile(r"({{.*?}}|{%.*?%})", re.S)


def tokenize(src):
    out = []
    for part in TOKEN.split(src):
        if not part:
            continue
        if part.startswith("{{"):
            out.append(("out", part[2:-2].strip()))
        elif part.startswith("{%"):
            out.append(("tag", part[2:-2].strip()))
        else:
            out.append(("text", part))
    return out
