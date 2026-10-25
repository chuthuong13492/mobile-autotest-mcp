import { defineConfig } from 'vitest/config';

/**
 * Two projects: `unit` (fast, file-parallel) and `slow` (real processes, real Flutter, fault injection, drills),
 * whose files run one at a time so their timing assertions do not compete with each other or with `unit`.
 * `pnpm test` runs `unit`, then `slow`.
 */
const SLOW = ['test/e2e/**/*.test.ts', 'resilience/**/*.test.ts', 'ops/**/*.test.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          globalSetup: ['test/globalSetup.ts'],
          include: [
            'packages/*/test/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
            'test/**/*.test.ts',
            'security/**/*.test.ts',
          ],
          exclude: SLOW,
          // Many unit suites spawn real processes (supervisors, runners); more workers than this overloads an 8-core
          // machine and makes the timing-window tests flaky.
          maxWorkers: 4,
        },
      },
      {
        test: {
          name: 'slow',
          environment: 'node',
          globalSetup: ['test/globalSetup.ts'],
          include: SLOW,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      // Test-support entrypoints (fakes, samples, contract kits) are exercised indirectly and not held to NFR-009.
      exclude: ['packages/*/src/testing/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
