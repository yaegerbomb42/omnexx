"""CSV (sensor,timestamp,value,unit) -> telemetry JSON Lines on stdout.

timestamp is ISO-8601 with an offset or Z, e.g. 2024-05-01T12:00:00+02:00.
"""
import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from producer.units import to_celsius  # noqa: E402


def _rows(path):
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            ts = datetime.fromisoformat(row["timestamp"].strip().replace("Z", "+00:00"))
            yield row["sensor"].strip(), ts, row["value"].strip(), row["unit"].strip().upper()


def iso_ms(ts):
    utc = ts.astimezone(timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (utc.microsecond // 1000)


def records(path):
    for sensor, ts, value, unit in _rows(path):
        if value:
            yield {"sensor": sensor, "ts": int(ts.timestamp()),
                   "value": round(to_celsius(float(value), unit), 3)}


def records_v2(path):
    for sensor, ts, value, unit in _rows(path):
        num = float(value) if value else None
        if num is not None and num.is_integer():
            num = int(num)
        yield {"v": 2, "sensor": sensor, "ts": iso_ms(ts), "value": num, "unit": unit}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--schema", type=int, choices=(1, 2), default=1)
    args = ap.parse_args(argv)
    gen = records_v2 if args.schema == 2 else records
    for rec in gen(args.input):
        sys.stdout.write(json.dumps(rec) + "\n")


if __name__ == "__main__":
    main()
