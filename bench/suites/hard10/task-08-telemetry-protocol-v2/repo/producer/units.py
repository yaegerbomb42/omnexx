"""Temperature unit conversion."""


def to_celsius(value, unit):
    unit = unit.strip().upper()
    if unit == "C":
        return value
    if unit == "F":
        return (value - 32) * 5 / 9
    if unit == "K":
        return value - 273.15
    raise ValueError("unknown unit " + unit)
