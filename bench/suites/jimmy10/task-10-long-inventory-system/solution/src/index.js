export class InventoryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
  }
}
const posInt = (q) => {
  if (!Number.isInteger(q) || q < 1) throw new InventoryError('INVALID_QTY');
};

class Inventory {
  constructor(state = { products: {}, reservations: {}, nextRes: 1 }) {
    this.s = state;
  }
  #p(sku) {
    const p = this.s.products[sku];
    if (!p) throw new InventoryError('UNKNOWN_SKU');
    return p;
  }
  addProduct({ sku, name, price, reorderLevel = 0 }) {
    if (this.s.products[sku]) throw new InventoryError('DUPLICATE_SKU');
    if (typeof price !== 'number' || !(price >= 0)) throw new InventoryError('INVALID_PRICE');
    this.s.products[sku] = { sku, name, price, reorderLevel, stock: 0, reserved: 0, history: [] };
  }
  getProduct(sku) {
    const p = this.s.products[sku];
    return p ? { sku: p.sku, name: p.name, price: p.price, reorderLevel: p.reorderLevel } : null;
  }
  receive(sku, qty) {
    const p = this.#p(sku);
    posInt(qty);
    p.stock += qty;
    p.history.push({ type: 'receive', qty, balance: p.stock });
  }
  ship(sku, qty) {
    const p = this.#p(sku);
    posInt(qty);
    if (qty > p.stock - p.reserved) throw new InventoryError('INSUFFICIENT_STOCK');
    p.stock -= qty;
    p.history.push({ type: 'ship', qty, balance: p.stock });
  }
  stock(sku) {
    return this.#p(sku).stock;
  }
  available(sku) {
    const p = this.#p(sku);
    return p.stock - p.reserved;
  }
  history(sku) {
    return this.#p(sku).history.map((h) => ({ ...h }));
  }
  lowStock() {
    return Object.values(this.s.products)
      .filter((p) => p.stock <= p.reorderLevel)
      .map((p) => p.sku)
      .sort((a, b) => a.localeCompare(b));
  }
  valuation() {
    return (
      Math.round(Object.values(this.s.products).reduce((t, p) => t + p.stock * p.price, 0) * 100) /
      100
    );
  }
  reserve(sku, qty) {
    const p = this.#p(sku);
    posInt(qty);
    if (qty > p.stock - p.reserved) throw new InventoryError('INSUFFICIENT_STOCK');
    p.reserved += qty;
    const id = `R${this.s.nextRes++}`;
    this.s.reservations[id] = { sku, qty };
    return id;
  }
  #res(id) {
    const r = this.s.reservations[id];
    if (!r) throw new InventoryError('UNKNOWN_RESERVATION');
    delete this.s.reservations[id];
    this.s.products[r.sku].reserved -= r.qty;
    return r;
  }
  release(id) {
    this.#res(id);
  }
  fulfil(id) {
    const r = this.#res(id);
    this.ship(r.sku, r.qty);
  }
  snapshot() {
    return JSON.stringify(this.s);
  }
}

export const createInventory = () => new Inventory();
export const restoreInventory = (json) => new Inventory(JSON.parse(json));
export function transfer(from, to, sku, qty) {
  if (!from.getProduct(sku) || !to.getProduct(sku)) throw new InventoryError('UNKNOWN_SKU');
  from.ship(sku, qty);
  to.receive(sku, qty);
}
