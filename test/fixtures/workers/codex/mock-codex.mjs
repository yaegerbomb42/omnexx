#!/usr/bin/env node
// Recorded replay fake for codex adapter contract tests
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V')) {
  console.log('codex-cli 0.132.0');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: codex exec [OPTIONS] [PROMPT] --json --ephemeral');
  process.exit(0);
}

const scenario = process.env.TEST_WORKER_SCENARIO || 'completed';

if (scenario === 'completed') {
  writeFileSync('out.txt', 'codex output\n');
  console.log(JSON.stringify({ type: 'item', msg: 'Resolved task with Codex', tokens: { in: 80, out: 30 } }));
  process.exit(0);
} else if (scenario === 'quota') {
  console.error('insufficient_quota: Quota exceeded');
  process.exit(1);
} else if (scenario === 'rate_limit') {
  console.error('rate_limit_exceeded');
  process.exit(1);
} else if (scenario === 'auth') {
  console.error('Missing API key / authentication_required');
  process.exit(1);
} else if (scenario === 'hang') {
  setInterval(() => {}, 1000);
} else {
  console.error('codex run failure');
  process.exit(1);
}
