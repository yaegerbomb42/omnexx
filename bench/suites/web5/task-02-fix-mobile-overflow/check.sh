#!/usr/bin/env bash
set -euo pipefail

# Hidden check: loads the page in headless Chrome at phone and desktop widths.
PROBE="$(cd "$(dirname "$0")/../lib" && pwd)/probe.mjs"
PAGE="$PWD/public/index.html"
VISIBLE='(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll(".card"));
  var img = document.querySelector(".hero img");
  var promo = document.querySelector(".promo code");
  var shown = function (el) { return !!el && el.offsetWidth > 100 && el.offsetHeight > 10 && getComputedStyle(el).visibility !== "hidden"; };
  return { cards: cards.length, allShown: cards.every(shown) && shown(img) && shown(promo),
    firstRowTops: cards.slice(0, 3).map(function (c) { return c.getBoundingClientRect().top; }),
    fourthTop: cards[3] ? cards[3].getBoundingClientRect().top : null };
})()'

node - "$PROBE" "$PAGE" "$VISIBLE" << 'EOF'
const [probePath, page, expr] = process.argv.slice(2);
const { probe } = await import(probePath);
const fail = (msg) => { console.error(msg); process.exit(1); };
const narrow = probe(page, 500, expr);
if (narrow.scrollWidth > narrow.innerWidth) fail(`overflows at ${narrow.innerWidth}px: ${narrow.scrollWidth}px wide`);
if (narrow.extra.cards !== 6 || !narrow.extra.allShown) fail(`content hidden on narrow screens: ${JSON.stringify(narrow.extra)}`);
const wide = probe(page, 1280, expr);
const tops = wide.extra.firstRowTops;
if (wide.scrollWidth > wide.innerWidth) fail('overflows on desktop');
if (!wide.extra.allShown) fail('content hidden on desktop');
if (new Set(tops).size !== 1 || wide.extra.fourthTop <= tops[0]) fail(`not three cards per row at 1280px: ${JSON.stringify(wide.extra)}`);
EOF
