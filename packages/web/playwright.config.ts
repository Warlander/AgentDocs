import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 800 },
  },
});
