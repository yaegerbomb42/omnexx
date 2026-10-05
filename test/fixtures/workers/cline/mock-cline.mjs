#!/usr/bin/env node
// Recorded replay fake for cline adapter contract tests
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V')) {
  console.log('3.0.62');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: cline [options] [command] [prompt] --json --auto-approve');
  process.exit(0);
}

const scenario = process.env.TEST_WORKER_SCENARIO || 'completed';

if (scenario === 'completed') {
  writeFileSync('out.txt', 'cline output\n');
  console.log(JSON.stringify({ type: 'say', say: 'text', message: 'Cline task resolved successfully' }));
  process.exit(0);
} else if (scenario === 'quota') {
  console.error('quota_exhausted: Insufficient balance');
  process.exit(1);
} else if (scenario === 'rate_limit') {
  console.error('RateLimitError: rate limit exceeded');
  process.exit(1);
} else if (scenario === 'auth') {
  console.error('auth_required: Missing API key');
  process.exit(1);
} else {
  console.error('cline failure');
  process.exit(1);
}
