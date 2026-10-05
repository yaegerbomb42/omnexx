#!/usr/bin/env node
// Recorded replay fake for gemini-cli adapter contract tests
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('gemini 0.2.1');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: gemini -p <prompt>');
  process.exit(0);
}

const scenario = process.env.TEST_WORKER_SCENARIO || 'completed';

if (scenario === 'completed') {
  writeFileSync('out.txt', 'gemini output\n');
  console.log('Finished writing code with Gemini');
  process.exit(0);
} else if (scenario === 'quota') {
  console.error('Error: quota_exhausted');
  process.exit(1);
} else if (scenario === 'rate_limit') {
  console.error('ResourceExhausted: rate limit exceeded');
  process.exit(1);
} else if (scenario === 'auth') {
  console.error('Unauthenticated: API key not valid');
  process.exit(1);
} else {
  console.error('gemini execution failed');
  process.exit(1);
}
