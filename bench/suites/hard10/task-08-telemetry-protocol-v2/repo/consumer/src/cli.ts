import { readFileSync } from 'node:fs';
import { parseLine } from './parse.ts';
import { summarize } from './summary.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node consumer/src/cli.ts <file.jsonl>');
  process.exit(2);
}
const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
console.log(JSON.stringify(summarize(lines.map(parseLine)), null, 2));
