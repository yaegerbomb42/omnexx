"""Built-in filters."""


def _default(value, fallback=""):
    return fallback if value is None or value == "" or not _defined(value) else value


def _defined(value):
    return type(value).__name__ != "Undefined"


FILTERS = {
    "upper": lambda v: str(v).upper(),
    "lower": lambda v: str(v).lower(),
    "length": lambda v: len(v) if _defined(v) else 0,
    "join": lambda v, sep="": sep.join(str(x) for x in v),
    "default": _default,
    "replace": lambda v, old, new: str(v).replace(old, new),
}
