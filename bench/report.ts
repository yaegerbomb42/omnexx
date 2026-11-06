import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resultsDir } from './results.ts';
import type { TaskRunResult } from './types.ts';

async function main(): Promise<void> {
  const out = process.argv.includes('--out')
    ? String(process.argv[process.argv.indexOf('--out') + 1])
    : 'results';
  const dir = resultsDir(out);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.log(`No results found in ${dir}`);
    process.exit(0);
  }

  const results: TaskRunResult[] = [];
  for (const f of files) {
    const content = await readFile(join(dir, f), 'utf-8');
    for (const line of content.trim().split('\n').filter(Boolean)) {
      results.push(JSON.parse(line) as TaskRunResult);
    }
  }

  const md = buildMarkdown(results);
  await writeFile(join(dir, 'report.md'), md, 'utf-8');

  const html = buildHtml(results);
  await writeFile(join(dir, 'report.html'), html, 'utf-8');

  console.log(`Report written to ${join(dir, 'report.md')} and ${join(dir, 'report.html')}`);
}

function buildMarkdown(results: TaskRunResult[]): string {
  const byAgent = new Map<string, TaskRunResult[]>();
  for (const r of results) {
    const rows = byAgent.get(r.agent) ?? [];
    rows.push(r);
    byAgent.set(r.agent, rows);
  }

  let md = '# Omnexx Benchmark Report\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Total runs: ${results.length}\n\n`;

  md += '## Agent Summary\n\n';
  md +=
    '| Agent | Runs | Resolved | Resolved % | Avg USD | Avg Wall | Avg Tokens In | Avg Tokens Out | Avg Cached | Turns | Re-read | Verified |\n';
  md +=
    '|-------|------|----------|------------|---------|----------|---------------|----------------|------------|-------|---------|----------|\n';
  for (const [agent, rows] of byAgent) {
    const ms = rows.map((r) => r.metrics);
    const resolved = ms.filter((m) => m.resolved).length;
    const avgUsd = ms.reduce((s, m) => s + m.usd, 0) / ms.length;
    const avgWall = ms.reduce((s, m) => s + m.wall_ms, 0) / ms.length;
    const avgIn = ms.reduce((s, m) => s + m.tokens_in, 0) / ms.length;
    const avgOut = ms.reduce((s, m) => s + m.tokens_out, 0) / ms.length;
    const avgCached = ms.reduce((s, m) => s + m.cached, 0) / ms.length;
    const avgTurns = ms.reduce((s, m) => s + (m.turns ?? 0), 0) / ms.length;
    const reReadVals = ms.filter((m) => m.re_read_ratio !== undefined);
    const avgReRead = reReadVals.length
      ? reReadVals.reduce((s, m) => s + (m.re_read_ratio ?? 0), 0) / reReadVals.length
      : 0;
    const verifiedVals = ms.filter((m) => m.verified_after_last_edit !== undefined);
    const avgVerified = verifiedVals.length
      ? verifiedVals.filter((m) => m.verified_after_last_edit).length / verifiedVals.length
      : 0;
    md += `| ${agent} | ${ms.length} | ${resolved} | ${((resolved / ms.length) * 100).toFixed(1)}% | $${avgUsd.toFixed(4)} | ${(avgWall / 1000).toFixed(1)}s | ${Math.round(avgIn).toLocaleString()} | ${Math.round(avgOut).toLocaleString()} | ${Math.round(avgCached).toLocaleString()} | ${avgTurns.toFixed(1)} | ${(avgReRead * 100).toFixed(1)}% | ${(avgVerified * 100).toFixed(1)}% |\n`;
  }

  md += '\n## Per-Task Results\n\n';
  const byTask = new Map<string, TaskRunResult[]>();
  for (const r of results) {
    const rows = byTask.get(r.taskId) ?? [];
    rows.push(r);
    byTask.set(r.taskId, rows);
  }
  for (const [taskId, rows] of byTask) {
    md += `### ${taskId}\n\n`;
    md +=
      '| Agent | Resolved | USD | Tokens In | Tokens Out | Cached | Wall | Turns | Re-read | Verified | Fail Label |\n';
    md +=
      '|-------|----------|-----|-----------|------------|--------|------|-------|---------|----------|------------|\n';
    for (const r of rows) {
      const m = r.metrics;
      md += `| ${r.agent} | ${m.resolved ? '✅' : '❌'} | $${m.usd.toFixed(4)} | ${m.tokens_in.toLocaleString()} | ${m.tokens_out.toLocaleString()} | ${m.cached.toLocaleString()} | ${(m.wall_ms / 1000).toFixed(1)}s | ${m.turns ?? '-'} | ${m.re_read_ratio === undefined ? '-' : (m.re_read_ratio * 100).toFixed(1)}% | ${m.verified_after_last_edit === undefined ? '-' : m.verified_after_last_edit ? '✅' : '❌'} | ${m.failure_label ?? '-'} |\n`;
    }
    md += '\n';
  }

  md += '## Failure Analysis\n\n';
  const failureCounts = new Map<string, number>();
  for (const r of results) {
    const label = r.metrics.failure_label;
    if (label && !r.metrics.resolved) {
      failureCounts.set(label, (failureCounts.get(label) ?? 0) + 1);
    }
  }
  if (failureCounts.size > 0) {
    md += '| Failure Label | Count |\n';
    md += '|---------------|-------|\n';
    for (const [label, count] of failureCounts) {
      md += `| ${label} | ${count} |\n`;
    }
  } else {
    md += 'No failures recorded.\n';
  }

  return md;
}

function buildHtml(results: TaskRunResult[]): string {
  const byAgent = new Map<string, TaskRunResult[]>();
  for (const r of results) {
    const rows = byAgent.get(r.agent) ?? [];
    rows.push(r);
    byAgent.set(r.agent, rows);
  }

  const agents = Array.from(byAgent.keys());
  const resolvedRates = agents.map((a) => {
    const rows = byAgent.get(a);
    if (!rows) return 0;
    const resolved = rows.filter((r) => r.metrics.resolved).length;
    return (resolved / rows.length) * 100;
  });
  const avgCosts = agents.map((a) => {
    const rows = byAgent.get(a);
    if (!rows) return 0;
    return rows.reduce((s, r) => s + r.metrics.usd, 0) / rows.length;
  });
  const avgTimes = agents.map((a) => {
    const rows = byAgent.get(a);
    if (!rows) return 0;
    return rows.reduce((s, r) => s + r.metrics.wall_ms, 0) / rows.length / 1000;
  });
  const avgTokens = agents.map((a) => {
    const rows = byAgent.get(a);
    if (!rows) return 0;
    return rows.reduce((s, r) => s + r.metrics.tokens_in + r.metrics.tokens_out, 0) / rows.length;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Omnexx Benchmark Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 2rem; background: #fafafa; }
  h1 { color: #1a1a1a; }
  h2 { color: #333; border-bottom: 2px solid #e5e5e5; padding-bottom: 0.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; margin: 2rem 0; }
  .card { background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .card h3 { margin-top: 0; color: #444; font-size: 1rem; }
  .big { font-size: 2.5rem; font-weight: bold; color: #2563eb; }
  .label { color: #666; font-size: 0.9rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
  th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  .resolved { color: #059669; }
  .failed { color: #dc2626; }
</style>
</head>
<body>
<h1>Omnexx Benchmark Report</h1>
<p>Generated: ${new Date().toISOString()}</p>
<p>Total runs: ${results.length}</p>

<div class="grid">
  <div class="card">
    <h3>Agents Compared</h3>
    <div class="big">${agents.length}</div>
    <div class="label">${agents.join(', ')}</div>
  </div>
  <div class="card">
    <h3>Total Runs</h3>
    <div class="big">${results.length}</div>
    <div class="label">task × agent × rep</div>
  </div>
  <div class="card">
    <h3>Overall Resolved</h3>
    <div class="big">${((results.filter((r) => r.metrics.resolved).length / results.length) * 100).toFixed(1)}%</div>
    <div class="label">${results.filter((r) => r.metrics.resolved).length} / ${results.length}</div>
  </div>
  <div class="card">
    <h3>Total Cost</h3>
    <div class="big">$${results.reduce((s, r) => s + r.metrics.usd, 0).toFixed(4)}</div>
    <div class="label">across all runs</div>
  </div>
</div>

<h2>Resolution Rate by Agent</h2>
<canvas id="resolvedChart" width="600" height="300"></canvas>

<h2>Average Cost by Agent</h2>
<canvas id="costChart" width="600" height="300"></canvas>

<h2>Average Wall Time by Agent</h2>
<canvas id="timeChart" width="600" height="300"></canvas>

<h2>Average Tokens by Agent</h2>
<canvas id="tokensChart" width="600" height="300"></canvas>

<h2>Per-Task Results</h2>
<table>
<thead><tr><th>Task</th><th>Agent</th><th>Resolved</th><th>USD</th><th>Tokens In</th><th>Tokens Out</th><th>Wall</th><th>Turns</th><th>Re-read</th><th>Verified</th><th>Fail Label</th></tr></thead>
<tbody>
${results
  .map((r) => {
    const m = r.metrics;
    const resolvedClass = m.resolved ? 'resolved' : 'failed';
    return `<tr>
    <td>${r.taskId}</td>
    <td>${r.agent}</td>
    <td class="${resolvedClass}">${m.resolved ? '✅' : '❌'}</td>
    <td>$${m.usd.toFixed(4)}</td>
    <td>${m.tokens_in.toLocaleString()}</td>
    <td>${m.tokens_out.toLocaleString()}</td>
    <td>${(m.wall_ms / 1000).toFixed(1)}s</td>
    <td>${m.turns ?? '-'}</td>
    <td>${m.re_read_ratio === undefined ? '-' : (m.re_read_ratio * 100).toFixed(1)}%</td>
    <td>${m.verified_after_last_edit === undefined ? '-' : m.verified_after_last_edit ? '✅' : '❌'}</td>
    <td>${m.failure_label ?? '-'}</td>
  </tr>`;
  })
  .join('')}
</tbody>
</table>

<script>
const agents = ${JSON.stringify(agents)};
const resolvedRates = ${JSON.stringify(resolvedRates)};
const avgCosts = ${JSON.stringify(avgCosts)};
const avgTimes = ${JSON.stringify(avgTimes)};
const avgTokens = ${JSON.stringify(avgTokens)};

new Chart(document.getElementById('resolvedChart'), {
  type: 'bar',
  data: { labels: agents, datasets: [{ label: 'Resolved %', data: resolvedRates, backgroundColor: '#2563eb' }] },
  options: { responsive: true, scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } } } }
});
new Chart(document.getElementById('costChart'), {
  type: 'bar',
  data: { labels: agents, datasets: [{ label: 'Avg USD', data: avgCosts, backgroundColor: '#059669' }] },
  options: { responsive: true, scales: { y: { beginAtZero: true, title: { display: true, text: 'USD' } } } }
});
new Chart(document.getElementById('timeChart'), {
  type: 'bar',
  data: { labels: agents, datasets: [{ label: 'Avg Wall Time (s)', data: avgTimes, backgroundColor: '#dc2626' }] },
  options: { responsive: true, scales: { y: { beginAtZero: true, title: { display: true, text: 'Seconds' } } } }
});
new Chart(document.getElementById('tokensChart'), {
  type: 'bar',
  data: { labels: agents, datasets: [{ label: 'Avg Tokens (in+out)', data: avgTokens, backgroundColor: '#7c3aed' }] },
  options: { responsive: true, scales: { y: { beginAtZero: true, title: { display: true, text: 'Tokens' } } } }
});
</script>
</body>
</html>`;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
