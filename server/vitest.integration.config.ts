import { defineConfig } from 'vitest/config';

// Integration tests talk to a real Postgres (the pte_test database from
// docker-compose). Files run one at a time because they share that database.
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
