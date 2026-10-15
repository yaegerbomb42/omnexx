#!/usr/bin/env bash
set -euo pipefail

# Hidden check: loads the page in headless Chrome and inspects errors, images and the list.
PROBE="$(cd "$(dirname "$0")/../lib" && pwd)/probe.mjs"
PAGE="$PWD/public/index.html"
STATE='({ items: Array.prototype.map.call(document.querySelectorAll("#todos li"), function (li) { return [li.textContent.trim(), li.classList.contains("done")]; }),
  summary: (document.getElementById("summary") || {}).textContent, logo: !!document.querySelector("header img") })'

node - "$PROBE" "$PAGE" "$STATE" << 'EOF'
const [probePath, page, expr] = process.argv.slice(2);
const { probe } = await import(probePath);
const fail = (msg) => { console.error(msg); process.exit(1); };
const r = probe(page, 1024, expr);
if (r.errors.length > 0) fail(`errors: ${r.errors.join('; ')}`);
if (r.brokenImages.length > 0 || !r.extra.logo) fail(`broken or missing images: ${r.brokenImages}`);
const want = [['Buy milk', true], ['Walk the dog', false], ['Ship the release', false]];
if (JSON.stringify(r.extra.items) !== JSON.stringify(want)) fail(`list: ${JSON.stringify(r.extra.items)}`);
if (r.extra.summary !== '2 left') fail(`summary: ${r.extra.summary}`);
EOF
