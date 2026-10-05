#!/usr/bin/env node
// Recorded replay fake for aider adapter contract tests
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('aider 0.86.2');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: aider --message-file <file> --yes-always --no-auto-commits');
  process.exit(0);
}

const scenario = process.env.TEST_WORKER_SCENARIO || 'completed';

if (scenario === 'completed') {
  writeFileSync('out.txt', 'aider output\n');
  console.log('Applied edit to out.txt\nTokens: 500 Cost: $0.02');
  process.exit(0);
} else if (scenario === 'quota') {
  console.error('insufficient_quota: OpenAI balance exceeded');
  process.exit(1);
} else if (scenario === 'rate_limit') {
  console.error('RateLimitError: Rate limit reached');
  process.exit(1);
} else if (scenario === 'auth') {
  console.error('AuthenticationError: No API key provided');
  process.exit(1);
} else {
  console.error('aider edit error');
  process.exit(1);
}
