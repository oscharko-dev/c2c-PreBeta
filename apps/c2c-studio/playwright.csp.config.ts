// Issue #271 / ADR-0005 §6 follow-up: dedicated Playwright config for
// the CI CSP gate. Diverges from ``playwright.config.ts`` the same way
// the a11y / perf / visual configs do:
//
//   * ``webServer`` runs only ``next start`` against the production
//     build — no BFF, no upstream services. The CSP spec asserts on
//     the headers and on hydration / Monaco mount against the empty
//     workbench shell at ``/``, which renders without a connected
//     backend. Keeping CI focused on the CSP contract avoids paying
//     the 10-service startup tax on every PR.
//
//   * ``grep`` is constrained to the ``@csp``-tagged spec so a stray
//     @perf / @memory test that lands in the e2e folder is not
//     accidentally picked up by the CSP job.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  grep: /@csp/,
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
