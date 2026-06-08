import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: ['default'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/example/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'example/',
        'tests/',
        '**/*.test.ts',
        '**/*.config.ts',
      ],
      // Regression FLOOR, not an aspiration. Set just below the measured numbers
      // (stmts 68.7 / branch 58.3 / funcs 75.4 / lines 69.3 as of v1.4.0) so the
      // gate catches a DROP in coverage without forcing busywork tests today.
      // Global (not per-file) by design — per-file 90% gates punish trivial files
      // and breed assertion-free stubs. Ratchet these UP as real coverage grows;
      // never lower them to make a red build pass.
      thresholds: {
        statements: 68,
        branches: 57,
        functions: 74,
        lines: 68,
      },
    },
  },
});
