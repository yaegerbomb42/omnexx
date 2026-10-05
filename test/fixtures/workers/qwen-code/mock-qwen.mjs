#!/usr/bin/env node
// Recorded replay fake for qwen-code adapter contract tests
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('qwen 0.3.0');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: qwen -p <prompt>');
  process.exit(0);
}

const scenario = process.env.TEST_WORKER_SCENARIO || 'completed';

if (scenario === 'completed') {
  writeFileSync('out.txt', 'qwen output\n');
  console.log('Generated code with Qwen');
  process.exit(0);
} else if (scenario === 'quota') {
  console.error('QuotaExceeded: free requests exhausted');
  process.exit(1);
} else if (scenario === 'rate_limit') {
  console.error('RateLimit: Too Many Requests');
  process.exit(1);
} else if (scenario === 'auth') {
  console.error('InvalidApiKey: Unauthorized');
  process.exit(1);
} else {
  console.error('qwen failed');
  process.exit(1);
}
