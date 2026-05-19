// Studio-IDE-12 (#250) follow-up: shared Playwright configuration for
// the required @perf and @memory specs.
//
// Like ``playwright.a11y.config.ts`` and ``playwright.visual.config.ts``,
// this config runs ONLY the Studio's production ``next start`` — no
// BFF, no upstream services. The perf/memory harnesses exercise the
// workbench shell at ``/`` and measure page-load + recycle latency
// against that surface. The ``grep`` selector at the workflow level
// (``--grep @perf`` / ``--grep @memory``) picks the right spec.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  testMatch: ["**/perf.spec.ts", "**/memory.spec.ts"],
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
        // Studio-IDE-12 (#250) §Memory: enable Chrome's
        // ``performance.measureUserAgentSpecificMemory()`` API so
        // the memory harness can actually assert the ≤ 10% heap
        // growth SLA against the COOP/COEP-isolated context the
        // middleware ships.
        launchOptions: {
          args: [
            "--enable-blink-features=ForceEagerMeasureMemory",
            "--enable-features=PerformanceMeasureMemory",
            "--enable-precise-memory-info",
          ],
        },
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
