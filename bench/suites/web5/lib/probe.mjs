// Loads a local page in headless Chrome at a given width and prints what a reviewer would
// check: horizontal overflow, script/resource errors, broken images, plus an optional
// expression's value. Usage: node probe.mjs <page.html> <width> [expression]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VIEWPORT_HEIGHT = 900;
const BUDGET_MS = 3000;
const CHROME_TIMEOUT_MS = 60_000;

const PLAYWRIGHT_BINARIES = [
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux/chrome',
  'chrome-linux64/chrome',
];

/** A Chrome or Chromium binary on this machine, or null. */
export function findChrome() {
  const fixed = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const p of fixed) if (p && existsSync(p)) return p;
  const caches = [
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
  ];
  for (const cache of caches.filter((c) => existsSync(c))) {
    const dirs = readdirSync(cache)
      .filter((n) => n.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      const hit = PLAYWRIGHT_BINARIES.map((sub) => join(cache, d, sub)).find((p) => existsSync(p));
      if (hit) return hit;
    }
  }
  return null;
}

const PROBE = (expr) => `<script>(function(){
  var errors = [];
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) errors.push('failed to load ' + (t.src || t.href));
    else errors.push(String(e.message || e));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { errors.push('unhandled rejection: ' + e.reason); });
  var origError = console.error;
  console.error = function () { errors.push('console.error: ' + Array.prototype.join.call(arguments, ' ')); return origError.apply(console, arguments); };
  window.addEventListener('load', function () { setTimeout(function () {
    var imgs = Array.prototype.slice.call(document.images);
    var out = { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, errors: errors,
      brokenImages: imgs.filter(function (i) { return !i.complete || i.naturalWidth === 0; }).map(function (i) { return i.getAttribute('src'); }) };
    try { out.extra = (function(){ return ${expr || 'null'}; })(); } catch (err) { out.extra = 'probe error: ' + err.message; }
    var pre = document.createElement('pre'); pre.id = '__probe';
    pre.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(out))));
    document.body.appendChild(pre);
  }, 300); });
})();</script>`;

/** Loads `page` at `width` px and returns the probe's findings. Throws when Chrome is missing. */
export function probe(page, width, expr) {
  const chrome = findChrome();
  if (!chrome) throw new Error('no Chrome/Chromium found (set CHROME_PATH)');
  const html = readFileSync(page, 'utf-8');
  const injected = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + PROBE(expr))
    : PROBE(expr) + html;
  // Next to the page, so its relative CSS, JS and image paths still resolve.
  const probeFile = join(dirname(resolve(page)), '.__probe.html');
  const profile = mkdtempSync(join(tmpdir(), 'web5-chrome-'));
  writeFileSync(probeFile, injected);
  try {
    const dom = execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        `--window-size=${width},${VIEWPORT_HEIGHT}`,
        `--virtual-time-budget=${BUDGET_MS}`,
        '--dump-dom',
        pathToFileURL(probeFile).href,
      ],
      { encoding: 'utf-8', timeout: CHROME_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = /<pre id="__probe">([^<]+)<\/pre>/.exec(dom);
    if (!m) throw new Error('page never finished loading');
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf-8'));
  } finally {
    rmSync(probeFile, { force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [page, width, expr] = process.argv.slice(2);
  console.log(JSON.stringify(probe(page, Number(width), expr)));
}
