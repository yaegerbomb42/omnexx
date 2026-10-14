/**
 * One plain-English line for what the agent is doing right now, written when an action starts:
 * "running test suite", "writing code to test.py", "browsing alexa.com", "clicking on @e3".
 */

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

const clip = (t: string, n = 70): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

const basename = (p: string): string => p.split('/').pop() ?? p;

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** What a shell command is for, in words; falls back to the command itself. */
export function describeCommand(cmd: string): string {
  const c = cmd.trim();
  const rules: [RegExp, string][] = [
    [
      /\b(vitest|jest|pytest|mocha|go test|cargo test|node --test|npm (run )?test|pnpm (run )?test|yarn test|bun test)\b/,
      'running test suite',
    ],
    [/\b(tsc|mypy|pyright)\b|\btypecheck\b/, 'checking types'],
    [
      /\b(eslint|ruff|flake8|clippy|golangci-lint)\b|\b(npm|pnpm|yarn) (run )?lint\b/,
      'checking codebase for errors',
    ],
    [/\b(prettier|black|gofmt|rustfmt)\b|\bformat\b/, 'formatting code'],
    [
      /\b(npm (ci|install|i)|pnpm (i|install)|yarn( install)?$|pip install|uv (sync|add)|cargo fetch|go mod download)\b/,
      'installing dependencies',
    ],
    [
      /\b(npm|pnpm|yarn) (run )?build\b|\b(tsup|vite build|webpack|cargo build|go build|make)\b/,
      'building the project',
    ],
    [/\bgit (diff|status|log|show)\b/, 'reviewing changes'],
    [/^(ls|tree|find)\b/, 'looking around the codebase'],
    [/^(cat|head|tail|less|sed -n)\b/, 'reading files'],
    [/^(rg|grep)\b/, 'searching the codebase'],
    [/\b(npm|pnpm|yarn) (run )?(dev|start)\b|\bnode .*server/, 'starting the app'],
    [/^curl\b|^wget\b/, 'making a web request'],
  ];
  for (const [re, words] of rules) if (re.test(c)) return words;
  return `running \`${clip(c, 60)}\``;
}

export function narrateTool(name: string, input: Record<string, unknown>): string {
  const path = s(input.path);
  switch (name) {
    case 'read':
      return IMAGE.test(path) ? `analyzing image ${path}` : `reading ${path}`;
    case 'outline':
      return `skimming the structure of ${path}`;
    case 'search': {
      const pattern = s(input.pattern).trim();
      return pattern ? `searching the codebase for ${clip(pattern, 50)}` : 'listing the files';
    }
    case 'list':
      return `listing ${path || 'the project'}`;
    case 'write_file':
      return `writing code to ${path}`;
    case 'str_replace':
    case 'multi_edit':
      return `editing ${path}`;
    case 'bash':
      return describeCommand(s(input.command));
    case 'read_log':
      return 'reading the full command output';
    case 'remember':
      return `remembering: ${clip(s(input.text), 60)}`;
    case 'recall':
      return `recalling earlier work about ${clip(s(input.query), 50)}`;
    case 'task':
      return `asking a helper: ${clip(s(input.description), 60)}`;
    case 'todo':
      return 'updating the todo list';
    case 'semantic_search':
      return `looking through the codebase for ${clip(s(input.query), 50)}`;
    case 'web_search':
      return `searching the web for ${clip(s(input.query), 50)}`;
    case 'web_fetch':
      return `reading ${host(s(input.url))}`;
    case 'skill':
      return `using the ${s(input.name) || 'requested'} skill`;
    case 'mcp_search':
      return `looking for a tool: ${clip(s(input.query), 50)}`;
    case 'mcp_call':
      return `using ${s(input.tool) || s(input.name) || 'an external tool'}`;
    case 'write_plan':
      return 'writing the plan';
    case 'write_intent':
      return 'working out what you want built';
    case 'browser': {
      const a = s(input.action);
      if (a === 'open') return `browsing ${host(s(input.url))}`;
      if (a === 'click') return `clicking on ${s(input.ref)}`;
      if (a === 'type') return `typing into ${s(input.ref)}`;
      if (a === 'press') return `pressing ${s(input.key)}`;
      if (a === 'scroll') return `scrolling ${s(input.direction) || 'down'}`;
      if (a === 'screenshot') return 'taking a screenshot to look at the page';
      if (a === 'snapshot') return 'reading the page';
      if (a === 'console') return 'checking the browser console for errors';
      if (a === 'close') return 'closing the browser';
      if (a === 'fill') return `filling in ${s(input.ref)}`;
      if (a === 'hover') return `hovering over ${s(input.ref)}`;
      if (a === 'select') return `choosing '${clip(s(input.value), 40)}' in ${s(input.ref)}`;
      if (a === 'check') return `ticking ${s(input.ref)}`;
      if (a === 'uncheck') return `unticking ${s(input.ref)}`;
      if (a === 'upload') return `uploading ${basename(s(input.path))}`;
      if (a === 'wait_for')
        return `waiting for ${s(input.ref) || `"${clip(s(input.text), 50)}"`} to appear`;
      if (a === 'get_text') return `reading the text of ${s(input.ref)}`;
      if (a === 'get_url') return 'checking which page the browser is on';
      if (a === 'eval') return 'running a script in the page';
      if (a === 'network') return 'checking the network for failed requests';
      if (a === 'tabs') return 'listing the open tabs';
      if (a === 'switch_tab') return `switching to tab ${s(input.tab)}`;
      if (a === 'new_tab') return `opening ${host(s(input.url))} in a new tab`;
      if (a === 'close_tab')
        return s(input.tab) ? `closing tab ${s(input.tab)}` : 'closing the tab';
      return `using the browser (${a})`;
    }
    default:
      return `using ${name}`;
  }
}

/** Sentences that only restate the request ("The user says: …", "We need to …"): models repeat these every turn. */
const RESTATES =
  /^(?:the\s+)?user(?:'s)?\b|^(?:we|i)\s+(?:need|have|want|should|must)\s+to\b|^(?:this|that)\s+is\s+vague\b|^(?:likely|probably|perhaps|maybe)\b|^per\b|^request\b/i;

/**
 * One line for a model's thinking: the decision, not the preamble. Models such as DeepSeek open
 * every thought by restating the request; the part worth showing is the end ("Let's list that
 * path."). Returns '' when nothing is left or it repeats `previous`.
 */
export function thinkingGist(text: string, previous = '', max = 200): string {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const fresh = sentences.filter((x) => !RESTATES.test(x) && !/"[^"]{20,}"/.test(x));
  const picked = (fresh.length ? fresh : sentences).slice(-2).join(' ');
  const gist = picked.length > max ? `…${picked.slice(-(max - 1))}` : picked;
  return gist && gist !== previous ? gist : '';
}
