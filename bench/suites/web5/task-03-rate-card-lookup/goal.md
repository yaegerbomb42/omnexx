# Task: Price Parcels from the Carrier's Rate Card

Implement `shippingCost(zone, kg)` in `src/shipping.js` from Parcelwing's **current** rate card,
including its billable-weight rules, surcharges and weight limit. The rate card is only on the
carrier portal: run `bash .docs/serve.sh &` and start at http://127.0.0.1:4803/.

## Success Criteria

- `npm test` passes
- Prices match the current rate card for every zone and weight; unknown zones and parcels the
  carrier refuses throw a `RangeError`
