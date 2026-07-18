import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Preloads sql.js when CALENDROME_TEST_ENGINE=sqljs; no-op otherwise.
    setupFiles: ['tests/setup-engine.ts'],
  },
});
