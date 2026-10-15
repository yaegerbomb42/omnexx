# Telemetry JSON Lines

One JSON object per line. Version 1 lines have no `v` field; version 2 lines have `"v": 2`.

## Version 1

| field    | type    | meaning                          |
| -------- | ------- | -------------------------------- |
| `sensor` | string  | sensor id                        |
| `ts`     | integer | Unix time in whole seconds (UTC) |
| `value`  | number  | temperature in degrees Celsius   |

Rows without a reading are dropped by the producer.

## Version 2

| field    | type           | meaning                                              |
| -------- | -------------- | ---------------------------------------------------- |
| `v`      | 2              | format version                                       |
| `sensor` | string         | sensor id                                            |
| `ts`     | string         | UTC ISO-8601 with milliseconds and `Z`               |
| `value`  | number or null | raw reading in `unit`; `null` when there was none    |
| `unit`   | `C`, `F`, `K`  | unit of `value`                                      |
