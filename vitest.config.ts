import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const gated = { lines: 85 };

export default defineConfig({
  resolve: {
    // `vscode` only exists inside the editor; tests mock it. See test/support/vscode-stub.ts.
    alias: { vscode: fileURLToPath(new URL('./test/support/vscode-stub.ts', import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.{ts,tsx}', 'src/core/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 120_000,
          globalSetup: ['test/support/global-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'chaos',
          include: ['test/chaos/**/*.test.ts'],
          testTimeout: 1_800_000,
          globalSetup: ['test/support/global-setup.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 600_000 },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        'src/core/**': gated,
        'src/verify/**': gated,
        'src/guard/**': gated,
        'src/security/**': gated,
        'src/git/**': gated,
        'src/judge/**': gated,
        'src/workers/**': gated,
      },
    },
  },
});
