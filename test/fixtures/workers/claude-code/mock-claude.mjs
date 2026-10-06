#!/usr/bin/env node
// Recorded replay fake for claude-code adapter contract tests
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('2.1.288 (Claude Code)');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Options: --output-format <format> --permission-mode <mode> --no-session-persistence');
  process.exit(0);
}

const scenario = process.env.TEST_WORKER_SCENARIO || 'completed';

if (scenario === 'completed') {
  writeFileSync('out.txt', 'claude output\n');
  console.log(JSON.stringify({ type: 'progress', text: 'working...' }));
  console.log(JSON.stringify({ type: 'result', result: 'Fixed task with Claude Code', total_cost_usd: 0.05, usage: { input_tokens: 120, output_tokens: 45 } }));
  process.exit(0);
} else if (scenario === 'quota') {
  console.error('Error: credit balance is too low / quota_exhausted');
  process.exit(1);
} else if (scenario === 'rate_limit') {
  console.error('rate_limit_error: Rate limit exceeded');
  process.exit(1);
} else if (scenario === 'auth') {
  console.error('authentication_error: Invalid API Key');
  process.exit(1);
} else if (scenario === 'hang') {
  setInterval(() => {}, 1000);
} else {
  console.error('generic failure');
  process.exit(1);
}
