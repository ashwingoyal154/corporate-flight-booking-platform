import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The store is a file-backed singleton; isolate workers so fixtures do not
    // collide (see DB_FILE in src/store/store.ts).
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
