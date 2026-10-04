#!/usr/bin/env node
// A fake coding harness for worker-lifecycle tests. Never a real tool.
// Usage: fake-worker.mjs <scenario.json>. Scenario: { mode, files?, commit?, pidFile?, deleteFile? }
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const s = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
// Everything in our env goes to stdout so tests can prove no supervisor secret reached us.
console.log(`fake-worker env: ${JSON.stringify(process.env)}`);
console.log(`fake-worker mode: ${s.mode}`);

for (const [path, content] of Object.entries(s.files ?? {})) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
if (s.deleteFile) rmSync(s.deleteFile);
if (s.commit) {
  git('add', '-A');
  git('-c', 'user.name=fake', '-c', 'user.email=fake@invalid', 'commit', '-qm', 'fake worker commit');
}

switch (s.mode) {
  case 'patch':
    console.log('SUMMARY: applied the scripted patch');
    process.exit(0);
  case 'fail':
    console.error('something went wrong');
    process.exit(2);
  case 'quota':
    console.error('Error: QUOTA EXHAUSTED for today');
    process.exit(3);
  case 'tamper':
    git('update-ref', 'refs/heads/evil', 'HEAD');
    console.log('SUMMARY: also moved a branch');
    process.exit(0);
  case 'push': {
    let pushed = 'no';
    try {
      git('push', 'origin', 'HEAD:refs/heads/stolen');
      pushed = 'yes';
    } catch {
      pushed = 'refused';
    }
    console.log(`push: ${pushed}`);
    process.exit(0);
  }
  case 'hang': {
    const child = spawn('sleep', ['1000'], { stdio: 'ignore' });
    writeFileSync(s.pidFile, String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.exit(1);
}
