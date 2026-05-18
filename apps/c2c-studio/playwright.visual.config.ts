// Studio-IDE-12 (#250) follow-up: dedicated Playwright configuration
// for the visual-regression suite. Mirrors ``playwright.a11y.config.ts``
// — production ``next start`` only, no BFF — so the visual baselines
// can be generated and verified against the same deterministic
// runtime the a11y gate uses.
//
// Snapshots are pinned to chromium / macOS per the existing
// workflow.spec.ts baseline policy. CI runs visual on the same
// chromium/Linux runner that runs a11y; the per-test ``test.skip``
// guards keep platform-specific baselines from running on the wrong
// host.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  // Constrain to the dedicated visual.spec.ts. The legacy
  // ``workflow.spec.ts`` ``@visual``-tagged baseline depends on the
  // full local stack (BFF + 8 services) and runs from
  // ``playwright.config.ts`` instead.
  testMatch: ["**/visual.spec.ts"],
  grep: /@visual/,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: {
    command: "npm run start -- --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
