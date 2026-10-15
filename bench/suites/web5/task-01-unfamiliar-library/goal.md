# Task: Implement cartTotal with an Unfamiliar Library

Implement `cartTotal(prices)` in `src/cart.js` using the vendored `tallyhq` v3 library in
`vendor/tallyhq/`. Prices are decimal strings; the result is the total rounded to cents with
banker's rounding (half to even), as a string with two decimals (`[]` gives `"0.00"`).

tallyhq 3 changed its API. Its documentation is served locally: run `bash .docs/serve.sh &`,
then read http://127.0.0.1:4801/.

## Success Criteria

- `npm test` passes
- `cartTotal` uses tallyhq and rounds the total half to even
