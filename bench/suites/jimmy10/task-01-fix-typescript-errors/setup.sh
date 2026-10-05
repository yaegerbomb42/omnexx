#!/usr/bin/env bash
set -euo pipefail

# Create a small project with TypeScript errors
cat > package.json << 'EOF'
{
  "name": "fix-typescript-errors",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
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
  "include": ["src"]
}
EOF

cat > src/utils.ts << 'EOF'
// Intentional type errors for the task

export function add(a: number, b: number): number {
  return a + b;
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

// Error: Property 'length' does not exist on type 'number'
export function getLength(x: string | number): number {
  return x.length;
}

// Error: Argument of type 'number' is not assignable to parameter of type 'string'
export function processString(s: string): string {
  return s.toUpperCase();
}

export function callProcess() {
  return processString(42); // Type error here
}

// Error: Object is possibly 'null'
export function getFirstChar(str: string | null): string {
  return str[0];
}
EOF

cat > test/utils.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { add, greet } from '../src/utils.js';

describe('utils', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('greets a name', () => {
    expect(greet('World')).toBe('Hello, World!');
  });
});
EOF

npm install