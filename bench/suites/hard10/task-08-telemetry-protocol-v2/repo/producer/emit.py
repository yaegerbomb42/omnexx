"""CSV (sensor,timestamp,value,unit) -> telemetry JSON Lines on stdout.

timestamp is ISO-8601 with an offset or Z, e.g. 2024-05-01T12:00:00+02:00.
"""
import argparse
import csv
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from producer.units import to_celsius  # noqa: E402


def records(path):
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            if not row["value"].strip():
                continue
            ts = datetime.fromisoformat(row["timestamp"].strip().replace("Z", "+00:00"))
            yield {
                "sensor": row["sensor"].strip(),
                "ts": int(ts.timestamp()),
                "value": round(to_celsius(float(row["value"]), row["unit"]), 3),
            }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    args = ap.parse_args(argv)
    for rec in records(args.input):
        sys.stdout.write(json.dumps(rec) + "\n")


if __name__ == "__main__":
    main()
