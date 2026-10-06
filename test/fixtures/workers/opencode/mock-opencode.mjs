#!/usr/bin/env node
// Recorded replay fake for opencode adapter contract tests
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('1.18.30');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: opencode run --dir <wt> --auto --format json');
  process.exit(0);
}

const scenario = process.env.TEST_WORKER_SCENARIO || 'completed';

if (scenario === 'completed') {
  writeFileSync('out.txt', 'opencode output\n');
  console.log(JSON.stringify({ type: 'summary', summary: 'Implemented in OpenCode', tokens: { input: 100, output: 50 } }));
  process.exit(0);
} else if (scenario === 'quota') {
  console.error('quota_exhausted: monthly quota reached');
  process.exit(1);
} else if (scenario === 'rate_limit') {
  console.error('Rate limit exceeded');
  process.exit(1);
} else if (scenario === 'auth') {
  console.error('Please configure provider credentials / auth_required');
  process.exit(1);
} else {
  console.error('opencode failed');
  process.exit(1);
}
