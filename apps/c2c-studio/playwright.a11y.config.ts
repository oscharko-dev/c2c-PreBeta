// Studio-IDE-12 (#250) follow-up: dedicated Playwright configuration
// for the CI a11y gate. Diverges from ``playwright.config.ts`` in two
// ways:
//
//   * ``webServer`` runs only ``next start`` against the production
//     build — no BFF, no upstream services. The a11y harness exercises
//     the workbench shell at ``/`` which renders the empty / no-run
//     state without a connected backend, so the full stack is not
//     needed and keeping CI focused on the a11y contract avoids
//     paying the 10-service startup tax on every PR.
//
//   * ``testMatch`` is constrained to the ``@a11y``-tagged specs so a
//     stray @perf / @memory test that lands in the e2e folder is not
//     accidentally picked up by the a11y job.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  // Only consider the a11y spec so the CI gate is unambiguous.
  grep: /@a11y/,
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
    // Production-mode Next start so the served bundle is what would
    // actually ship. The build step is invoked by the CI workflow
    // before this config runs (``npm run build``).
    command: "npm run start -- --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
