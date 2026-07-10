import { defineConfig } from '@playwright/test';

/**
 * E2E tests for the interactive GUI (`npm run test:e2e`) — separate
 * from `npm test` (vitest is scoped to tests/**). Each spec seeds its
 * own temp DB and spawns the built GUI server, so run `npm run build`
 * first. Set PW_CHROMIUM to use a preinstalled browser binary
 * (e.g. /opt/pw-browsers/chromium) instead of a downloaded one.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    viewport: { width: 1400, height: 900 },
    launchOptions: process.env.PW_CHROMIUM
      ? { executablePath: process.env.PW_CHROMIUM }
      : {},
  },
});
