# Task: Refactor the Shipping Quote Engine and Add Drone Delivery

`shipping.py` has one 100-line `quote()` function with a module-level cache. Refactor it and then
add a feature.

1. **Refactor without changing behavior.** Turn `shipping` into a package (a `shipping/`
   directory; delete `shipping.py`) split by responsibility: billable weight, carrier
   selection and base rates, surcharges, coupons/discounts. `from shipping import quote` must keep
   working, and for every order that does not opt into drones (below) `quote()` must return
   exactly what it returns today: same carrier, cents, ETA, notes in the same order, and the same
   `ValueError` messages, including today's quirks (rounding, order of discounts). No function
   in the package may be longer than 40 lines. Remove the module-level `_rate_cache`: it is
   mutable global state, quotes are cheap, and it has a bug (a quote served from the cache can
   differ from the first, uncached quote for the same order). "Today's behavior" means what a
   fresh process returns for the first call with that order.
2. **Add drone delivery.** An order may carry `"drone_ok": True`. When it does, and the order is
   domestic (`US`), not express, has no hazmat items, and its billable weight is at most 5 kg,
   the carrier is `"drone"` with ETA 0 days and base cost `900 + 150 * billable_kg` cents
   (truncate to whole cents like the other carriers), instead of postal/ground. Remote-area rules
   do not apply (drones are US-only). `FREESHIP` does not apply to drones (note
   `"coupon FREESHIP not applicable"`), `HALFAIR` does not either (`"coupon HALFAIR not
applicable"`); the member discount does. All other orders, including those with
   `"drone_ok": False` or ineligible ones, are quoted exactly as before.

Add tests for the drone rules.

## Success Criteria

- `python3 -m unittest discover -s tests` passes
- `shipping` is a package; old behavior is preserved exactly for non-drone orders
- Drone quotes follow the rules above; no function over 40 lines; no module-level mutable cache
