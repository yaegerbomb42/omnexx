import sys

from .parse import read_entries
from .report import monthly_totals, render


def main(argv):
    if len(argv) != 3 or argv[0] != "report":
        print("usage: python3 -m ledger report <file.csv> <YYYY-MM>", file=sys.stderr)
        return 2
    print(render(monthly_totals(read_entries(argv[1]), argv[2])))
    return 0


sys.exit(main(sys.argv[1:]))
