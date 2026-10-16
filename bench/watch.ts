import { program } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { liveDir, type LiveStatus } from './live.ts';

/**
 * `npm run bench:watch -- --out <name>`: a local page with one card per run, showing each
 * agent's output as it works, its tokens so far, elapsed time and PASS/FAIL at the end.
 */

const TAIL_LINES = 60;
const MAX_LINE = 300;

// Built from a string so the escape character isn't a control character in a regex literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** A readable line from agent output: Cline's --json events show their text, the rest as is. */
export function readable(line: string): string | undefined {
  const clean = line.replace(ANSI, '').trimEnd();
  if (!clean.trim()) return undefined;
  if (clean.startsWith('{')) {
    try {
      const j = JSON.parse(clean) as Record<string, unknown>;
      const text = [j.text, j.message, j.content, j.say, j.ask].find(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
      );
      if (!text) return undefined;
      const kind = typeof j.say === 'string' ? j.say : typeof j.type === 'string' ? j.type : '';
      return `${kind ? `[${kind}] ` : ''}${text}`.slice(0, MAX_LINE);
    } catch {
      // Not JSON after all: show it as text.
    }
  }
  return clean.slice(0, MAX_LINE);
}

export function tail(log: string, n = TAIL_LINES): string[] {
  return log
    .split(/\r?\n/)
    .map(readable)
    .filter((l): l is string => l !== undefined)
    .slice(-n);
}

async function snapshot(dir: string): Promise<(LiveStatus & { lines: string[] })[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
  const runs = await Promise.all(
    names.map(async (f) => {
      const status = JSON.parse(await readFile(join(dir, f), 'utf-8')) as LiveStatus;
      const log = await readFile(join(dir, f.replace(/\.json$/, '.log')), 'utf-8').catch(() => '');
      return { ...status, lines: tail(log) };
    }),
  );
  return runs.sort((a, b) => a.task.localeCompare(b.task) || a.agent.localeCompare(b.agent));
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>omnexx bench · live</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262a33;--fg:#e6e6e6;--muted:#8a90a0;--omnexx:#00e676;--cline:#4da3ff;--openhands:#ffb74d;--pass:#00e676;--fail:#ff5252;--run:#ffd54f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 -apple-system,system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;background:rgba(15,17,21,.95);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0}.score{display:flex;gap:10px;flex-wrap:wrap}
.chip{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px}
.chip b{color:var(--c)}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px;padding:12px 16px}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--c);border-radius:8px;display:flex;flex-direction:column;min-height:260px;max-height:420px}
.head{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line);gap:8px}
.who{font-weight:600}.who span{color:var(--c)}.task{color:var(--muted);font-size:12px}
.state{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--s) 18%,transparent);color:var(--s)}
.meta{display:flex;gap:12px;padding:6px 10px;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line)}
.meta b{color:var(--fg);font-weight:600}
pre{margin:0;padding:8px 10px;overflow:auto;flex:1;font:11.5px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:#c9ced8}
.empty{color:var(--muted);padding:40px;text-align:center}
@media (max-width:480px){main{grid-template-columns:1fr;padding:8px}}
</style></head><body>
<header><h1>omnexx bench · live</h1><div class="score" id="score"></div><span class="chip" id="clock"></span></header>
<main id="grid"><div class="empty">Waiting for runs…</div></main>
<script>
const color={omnexx:'var(--omnexx)',cline:'var(--cline)',openhands:'var(--openhands)'};
const stateColor={queued:'var(--muted)',running:'var(--run)',pass:'var(--pass)',fail:'var(--fail)',error:'var(--fail)'};
const k=n=>n>=1000?(n/1000).toFixed(n>=10000?0:1)+'k':String(n);
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const secs=(a,b)=>a?Math.round(((b?Date.parse(b):Date.now())-Date.parse(a))/1000):0;
const fmt=s=>s>=60?Math.floor(s/60)+'m '+String(s%60).padStart(2,'0')+'s':s+'s';
const stuck=new Set();
async function tick(){
  const runs=await (await fetch('/api')).json();
  const grid=document.getElementById('grid');
  if(!runs.length){return}
  const agents=[...new Set(runs.map(r=>r.agent))];
  document.getElementById('score').innerHTML=agents.map(a=>{
    const rs=runs.filter(r=>r.agent===a),done=rs.filter(r=>r.state==='pass'||r.state==='fail'||r.state==='error');
    const pass=rs.filter(r=>r.state==='pass').length;
    const tok=done.length?Math.round(done.reduce((s,r)=>s+(r.tokens?.fresh||0),0)/done.length):0;
    const t=done.length?Math.round(done.reduce((s,r)=>s+secs(r.startedAt,r.finishedAt),0)/done.length):0;
    return '<span class="chip" style="--c:'+(color[a]||'#ccc')+'"><b>'+a+'</b> '+pass+'/'+rs.length+' pass · '+done.length+' done'+(done.length?' · avg '+k(tok)+' fresh · '+fmt(t):'')+'</span>';
  }).join('');
  const keep={};document.querySelectorAll('pre').forEach(p=>{keep[p.dataset.tag]=p.scrollHeight-p.scrollTop-p.clientHeight>20?p.scrollTop:null});
  grid.innerHTML=runs.map(r=>{
    const s=secs(r.startedAt,r.finishedAt),t=r.tokens;
    return '<div class="card" style="--c:'+(color[r.agent]||'#ccc')+'"><div class="head"><div><div class="who"><span>'+r.agent+'</span> · r'+r.rep+'</div><div class="task">'+esc(r.task)+'</div></div><span class="state" style="--s:'+stateColor[r.state]+'">'+r.state.toUpperCase()+'</span></div>'
    +'<div class="meta"><span>time <b>'+fmt(s)+'</b></span><span>fresh <b>'+k(t?.fresh||0)+'</b></span><span>cached <b>'+k(t?.cached||0)+'</b></span><span>calls <b>'+(t?.requests||0)+'</b></span></div>'
    +'<pre data-tag="'+esc(r.tag)+'">'+esc((r.lines||[]).join('\\n')||(r.state==='queued'?'queued…':'starting…'))+(r.error?'\\n\\n'+esc(r.error):'')+'</pre></div>';
  }).join('');
  document.querySelectorAll('pre').forEach(p=>{const v=keep[p.dataset.tag];p.scrollTop=v==null?p.scrollHeight:v});
  document.getElementById('clock').textContent=new Date().toLocaleTimeString();
}
tick();setInterval(()=>tick().catch(()=>{}),1500);
</script></body></html>`;

function main(): void {
  program
    .requiredOption('--out <dir>', 'the result set to watch (the --out given to npm run bench)')
    .option('--port <n>', 'port for the page', '8787')
    .option('--no-open', "don't open the browser")
    .parse();
  const opts = program.opts<{ out: string; port: string; open: boolean }>();
  const dir = liveDir(resolve(opts.out));
  const server = createServer((req, res) => {
    if (req.url === '/api') {
      snapshot(dir)
        .then((runs) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(runs));
        })
        .catch((err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  server.listen(Number(opts.port), '127.0.0.1', () => {
    const url = `http://127.0.0.1:${opts.port}`;
    console.log(`Watching ${dir}\n${url}`);
    if (opts.open)
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => undefined);
  });
}

if (process.argv[1]?.endsWith('watch.ts')) main();
