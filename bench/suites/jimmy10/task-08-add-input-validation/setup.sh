#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "task-08-add-input-validation",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
mkdir -p src
cat > src/orders.js << 'EOF'
let nextId = 1;
export function createOrder(input) {
  const total = input.items.reduce((s, i) => s + i.qty * i.price, 0);
  const discount = input.coupon ? 0.1 : 0;
  return { id: nextId++, customerId: input.customerId, items: input.items, total: Math.round(total * (1 - discount) * 100) / 100 };
}
EOF
