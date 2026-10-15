# Telemetry JSON Lines, version 1

One JSON object per line:

| field    | type    | meaning                                  |
| -------- | ------- | ---------------------------------------- |
| `sensor` | string  | sensor id                                |
| `ts`     | integer | Unix time in whole seconds (UTC)         |
| `value`  | number  | temperature in degrees Celsius           |

Rows without a reading are dropped by the producer.
