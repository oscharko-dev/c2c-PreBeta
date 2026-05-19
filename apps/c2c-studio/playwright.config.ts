import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = path.resolve(__dirname, '../..');
const envFile = path.resolve(repoRoot, '.env');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: {
    command: './scripts/start-c2c-local.sh --ci',
    cwd: repoRoot,
    env: {
      ...process.env,
      C2C_LOCAL_ENV_FILE: envFile,
      C2C_LOCAL_MODEL_GATEWAY_ENABLED: 'false',
      NEXT_PUBLIC_C2C_E2E_HARNESS: '1',
    },
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
  },
});
