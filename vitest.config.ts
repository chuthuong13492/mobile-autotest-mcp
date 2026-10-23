import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      // Test-support entrypoints (fakes, samples, contract kits) are exercised indirectly and not held to NFR-009.
      exclude: ['packages/*/src/testing/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
