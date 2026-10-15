import { readFileSync } from 'node:fs';
import { parseLine, type Reading } from './parse.ts';
import { summarize } from './summary.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node consumer/src/cli.ts <file.jsonl>');
  process.exit(2);
}
const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
const parsed = lines.map(parseLine);
const readings = parsed.filter((r): r is Reading => r !== null);
const out = { sensors: summarize(readings), skipped: parsed.length - readings.length };
console.log(JSON.stringify(out, null, 2));
