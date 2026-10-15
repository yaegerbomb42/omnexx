# Task: Fix the Page Overflowing on Narrow Screens

On narrow screens (500px wide) the store page in `public/` scrolls sideways: something is wider
than the viewport. Fix the CSS so nothing overflows horizontally at 500px. On a 1280px desktop
the product cards must still show three per row, and every card, the hero image, and the promo
code must stay visible (don't hide content to make it fit).

Look at the page in the browser to find what overflows: run `bash .docs/serve.sh &` and open
http://127.0.0.1:4802/ (or open `public/index.html`), and check it again after your change.

## Success Criteria

- No horizontal overflow at 500px; three cards per row at 1280px; nothing hidden
