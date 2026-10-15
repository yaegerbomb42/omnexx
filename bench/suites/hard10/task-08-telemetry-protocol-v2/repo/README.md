# telemetry

- `producer/` (Python 3, stdlib only): `python3 producer/emit.py --input readings.csv` turns a
  CSV export from the sensor gateway into JSON Lines on stdout.
- `consumer/` (TypeScript run directly by Node >= 22.18, erasable syntax only):
  `node consumer/src/cli.ts readings.jsonl` prints a JSON summary per sensor.
- `docs/PROTOCOL.md` describes the JSON Lines format.

`npm test` runs both test suites.
