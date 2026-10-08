# Task: Validate Order Input

`createOrder` in `src/orders.js` trusts its input. Add validation that throws a `ValidationError`
(export the class from `src/orders.js`) with a `field` property naming the first bad field:

- `customerId`: non-empty string
- `items`: non-empty array; each item has a non-empty string `sku`, an integer `qty` from 1 to 100, and a `price` that is a finite number >= 0
- `coupon` (optional): matches /^[A-Z0-9]{4,12}$/

Valid orders behave exactly as before.

## Success Criteria

- `npm test` passes with tests covering each rule
