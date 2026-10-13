export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}
function validate(input) {
  if (typeof input.customerId !== 'string' || !input.customerId)
    throw new ValidationError('customerId', 'customerId required');
  if (!Array.isArray(input.items) || !input.items.length)
    throw new ValidationError('items', 'items required');
  for (const i of input.items) {
    if (typeof i.sku !== 'string' || !i.sku) throw new ValidationError('sku', 'bad sku');
    if (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > 100)
      throw new ValidationError('qty', 'bad qty');
    if (typeof i.price !== 'number' || !Number.isFinite(i.price) || i.price < 0)
      throw new ValidationError('price', 'bad price');
  }
  if (input.coupon !== undefined && !/^[A-Z0-9]{4,12}$/.test(input.coupon))
    throw new ValidationError('coupon', 'bad coupon');
}
let nextId = 1;
export function createOrder(input) {
  validate(input);
  const total = input.items.reduce((s, i) => s + i.qty * i.price, 0);
  const discount = input.coupon ? 0.1 : 0;
  return {
    id: nextId++,
    customerId: input.customerId,
    items: input.items,
    total: Math.round(total * (1 - discount) * 100) / 100,
  };
}
