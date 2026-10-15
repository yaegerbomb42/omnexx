# Task: Telemetry Protocol Version 2 (Producer and Consumer)

The gateway team needs version 2 of the telemetry JSON Lines format. Implement it end to end:
the Python producer must be able to emit it, and the TypeScript consumer must read v1, v2, and
files that mix both. Update `docs/PROTOCOL.md` and add tests on both sides.

**v2 line format.** `{"v": 2, "sensor": str, "ts": str, "value": number | null, "unit": "C" | "F" | "K"}`:

- `ts` is UTC ISO-8601 with milliseconds and `Z`, exactly like JavaScript's
  `Date.prototype.toISOString()` (e.g. `2024-05-01T10:00:00.000Z`), keeping sub-second precision
  from the input.
- `value` is the raw reading in its original `unit` (no conversion in the producer), or `null`
  when the CSV cell is empty (v2 keeps those rows instead of dropping them).
- A v1 line is one with no `v` field (format in `docs/PROTOCOL.md`).

**Producer.** `python3 producer/emit.py --input file.csv --schema 2` emits v2; `--schema 1` and
no `--schema` keep emitting exactly today's v1 output.

**Consumer.** `node consumer/src/cli.ts file.jsonl` prints one JSON document:

```json
{
  "sensors": {
    "<sensor id>": {
      "count": 0,
      "missing": 0,
      "min": 0,
      "max": 0,
      "mean": 0,
      "first": "<ISO ts>",
      "last": "<ISO ts>"
    }
  },
  "skipped": 0
}
```

- All values are converted to Celsius before aggregating. `count` is readings with a value;
  `missing` is readings whose value is `null`. `min`/`max`/`mean` are over the values, rounded to
  2 decimals, and `null` when a sensor has no values.
- `first`/`last` are the earliest and latest timestamps of the sensor's readings (with or
  without a value), formatted like `toISOString()`. Lines are not necessarily in time order.
- Lines that are blank are ignored. Lines that are not valid JSON, or that do not match v1 or v2
  (missing or wrong-typed fields, unknown `v`, unknown unit), are not counted for any sensor and
  increase `skipped`.

## Success Criteria

- `npm test` passes
- The producer emits correct v2 (and unchanged v1); the consumer summarizes v1, v2 and mixed
  files as specified
