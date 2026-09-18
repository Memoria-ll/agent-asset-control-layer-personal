import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: 'ui.spec.ts',
  workers: 1,
  timeout: 60000,
  reporter: 'list',
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
