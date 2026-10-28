#!/usr/bin/env python3
"""Evolutionary loop on pruneSuperseded() using Groq qwen/qwen3.8-27b. Keys from env GROQ_API_KEY_1..14."""
import json, os, re, subprocess, sys, time, urllib.request, random, itertools
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'src/agent/compaction.ts')
LOG = os.path.join(ROOT, 'evolve-log.jsonl')
OUT = os.path.join(ROOT, 'bench/evolve-prune/candidates')
os.makedirs(OUT, exist_ok=True)
KEYS = [os.environ[k] for k in sorted(os.environ) if re.fullmatch(r'GROQ_API_KEY_\d+', k)]
keycyc = itertools.cycle(range(len(KEYS)))
ORIG = open(SRC).read()
START = ORIG.index("const SUPERSEDED_PREFIX")
END = ORIG.index("/**\n * Split after the first message")
BASE_REGION = ORIG[START:END]
GENS = int(sys.argv[1]) if len(sys.argv) > 1 else 15
POP = int(sys.argv[2]) if len(sys.argv) > 2 else 3

def log(ev): open(LOG, 'a').write(json.dumps({'t': time.time(), **ev}) + '\n')

def evaluate(region):
    open(SRC, 'w').write(ORIG[:START] + region + ORIG[END:])
    try:
        r = subprocess.run(['npx', 'tsx', 'bench/evolve-prune/score.ts'], cwd=ROOT, capture_output=True, text=True, timeout=120)
        if r.returncode: return {'ok': False, 'why': 'compile/runtime: ' + (r.stderr or r.stdout)[-600:]}
        s = json.loads(r.stdout)
        t = subprocess.run(['npx', 'vitest', 'run', 'test/unit/agent/prune.test.ts', 'test/unit/agent/compaction.test.ts'], cwd=ROOT, capture_output=True, text=True, timeout=300)
        s['tests'] = t.returncode == 0
        if not s['tests']: s['testfail'] = re.findall(r'(?:FAIL|AssertionError|Expected).*', t.stdout)[:6]
        drops = s['train']['dropped'] + s['holdout']['dropped']
        s['ok'] = s['tests'] and not s['train']['dropped']
        s['why'] = '' if s['ok'] else ('tests failed: %s' % s.get('testfail') if not s['tests'] else 'dropped must-keep: %s' % s['train']['dropped'])
        return s
    finally:
        open(SRC, 'w').write(ORIG)

def brief(s):
    return {k: {'tokens': v['tokens'], 'raw': v['raw'], 'dropped': v['dropped']} for k, v in s['perCase'].items() if not k.startswith('ho-')}

SYS = ("You improve one TypeScript function in a coding-agent harness. pruneSuperseded(messages) replaces tool results that later "
"steps made dead weight with a short stub starting with SUPERSEDED_PREFIX, keeping every tool_use/tool_result block in place. "
"Goal: fewer tokens on the training transcripts, but NEVER drop info still needed: the newest result of any repeated call, any "
"unresolved error, the only copy of a file's contents, results of distinct commands/patterns. Available in scope (do not redefine): "
"CLEARED_PREFIX: string, clip(s: string, n: number): string, types ContentBlock and Message (content blocks: text | tool_use{id,name,input} | "
"tool_result{toolUseId,content,isError?}). Tools: read{path,start?,end?}, edit{path,...}, write_file{path}, bash{command}, grep{pattern,path?}, glob{pattern}. "
"Keep the exported signature and return shape. Existing unit tests require: read superseded by a later covering read of same path; a narrower later read "
"must NOT supersede a wider earlier one; stub text formats like '[superseded by omnexx: src/a.ts was read again later' and bash rerun messages. "
"Reply with ONLY one ```ts code block containing the full replacement region (from `const SUPERSEDED_PREFIX` through the end of pruneSuperseded).")

def ask(parent, pscore, hint, failures):
    user = (f"Current best region:\n```ts\n{parent}\n```\nPer-case train score (tokens after/raw, dropped facts):\n{json.dumps(brief(pscore))}\n"
            f"Recent failed attempts (avoid these):\n{json.dumps(failures[-3:])[:1200]}\nMutation idea to try: {hint}\nKeep it concise and correct.")
    body = json.dumps({'model': 'qwen/qwen3.8-27b', 'messages': [{'role': 'system', 'content': SYS}, {'role': 'user', 'content': user}],
                       'max_completion_tokens': 3500, 'temperature': 0.7, 'reasoning_format': 'hidden'}).encode()
    for attempt in range(len(KEYS)):
        ki = next(keycyc)
        req = urllib.request.Request('https://api.groq.com/openai/v1/chat/completions', body, {'Authorization': 'Bearer ' + KEYS[ki], 'Content-Type': 'application/json', 'User-Agent': 'omx-evolve'})
        try:
            d = json.load(urllib.request.urlopen(req, timeout=180))
            txt = d['choices'][0]['message']['content']; u = d.get('usage', {})
            m = re.search(r'```(?:ts|typescript)?\n(.*?)```', txt, re.S)
            return (m.group(1) if m else None), u, ki
        except urllib.error.HTTPError as e:
            log({'event': 'http_error', 'key': ki + 1, 'code': e.code, 'body': e.read()[:200].decode('utf8', 'replace')}); time.sleep(2)
        except Exception as e:
            log({'event': 'error', 'key': ki + 1, 'err': str(e)[:200]})
    return None, {}, -1

HINTS = ["treat a repeated grep/glob with identical input as superseded by the later identical call",
         "normalize bash commands (collapse whitespace, trim) before comparing reruns",
         "a read becomes stale when a later edit/write_file of the same path is followed by a later read of that path (any range) - but keep it if no later read exists",
         "generalize: any tool call with deep-equal normalized input repeated later supersedes the earlier one, except edits/writes",
         "shorten the stub text while keeping the required prefixes",
         "combine the best ideas; simplify code", "your own idea for removing dead weight safely"]

def fit(s): return s['train']['tokens'] if s.get('ok') else 10**9

base = evaluate(BASE_REGION); log({'event': 'baseline', 'train': base['train'], 'holdout': base['holdout'], 'tests': base['tests']})
pop = [(BASE_REGION, base)]; failures = []; calls = 0
for g in range(GENS):
    for c in range(POP):
        parent, ps = random.choice(pop[:2]) if len(pop) > 1 else pop[0]
        hint = HINTS[(g * POP + c) % len(HINTS)]
        code, usage, ki = ask(parent, ps, hint, failures); calls += 1
        if not code: log({'event': 'no_code', 'gen': g, 'usage': usage}); continue
        s = evaluate(code); fn = f'{OUT}/g{g:02d}c{c}.ts'; open(fn, 'w').write(code)
        rec = {'event': 'candidate', 'gen': g, 'cand': c, 'hint': hint, 'key': ki + 1, 'usage': usage, 'file': os.path.relpath(fn, ROOT),
               'ok': s.get('ok'), 'why': s.get('why'), 'train': s.get('train'), 'holdout': s.get('holdout')}
        log(rec); print(json.dumps({k: rec[k] for k in ('gen', 'cand', 'ok', 'why')}), (s.get('train') or {}).get('tokens'), (s.get('holdout') or {}).get('tokens'), usage.get('total_tokens'), flush=True)
        if s.get('ok'): pop.append((code, s))
        else: failures.append({'hint': hint, 'why': (s.get('why') or '')[:300]})
    pop.sort(key=lambda p: fit(p[1])); pop = pop[:4]
    log({'event': 'gen_done', 'gen': g, 'best_train': fit(pop[0][1]), 'best_holdout': pop[0][1]['holdout']['tokens'], 'calls': calls})
    open(f'{OUT}/best.ts', 'w').write(pop[0][0])
    subprocess.run(f'git add -A bench evolve-log.jsonl && git commit -qm "bench: evolve-prune gen {g}" && git push -q origin feat/evolved-compaction', shell=True, cwd=ROOT, capture_output=True)
print('DONE best train', fit(pop[0][1]), 'holdout', pop[0][1]['holdout'])
