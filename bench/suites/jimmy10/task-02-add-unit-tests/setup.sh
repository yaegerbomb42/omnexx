#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "add-unit-tests",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0",
    "@vitest/coverage-v8": "^1.0.0"
  }
}
EOF

mkdir -p src test

cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
EOF

cat > src/calculator.ts << 'EOF'
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  divide(a: number, b: number): number {
    if (b === 0) {
      throw new Error('Division by zero');
    }
    return a / b;
  }

  power(base: number, exponent: number): number {
    return Math.pow(base, exponent);
  }

  sqrt(n: number): number {
    if (n < 0) {
      throw new Error('Square root of negative number');
    }
    return Math.sqrt(n);
  }

  factorial(n: number): number {
    if (n < 0 || !Number.isInteger(n)) {
      throw new Error('Factorial requires non-negative integer');
    }
    if (n === 0 || n === 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) {
      result *= i;
    }
    return result;
  }
}

export const calculator = new Calculator();
EOF

cat > test/calculator.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { calculator } from '../src/calculator.js';

// Only basic tests exist - need to add comprehensive tests
describe('calculator', () => {
  it('adds two numbers', () => {
    expect(calculator.add(2, 3)).toBe(5);
  });
});
EOF

npm install