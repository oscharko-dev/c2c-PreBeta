// Studio-IDE-12 (#250) — visual regression baselines for structural
// elements only.
//
// Issue #250 §Visual Regression mandates that snapshots stay scoped to
// structural elements (toolbar layout, marker gutter glyphs, trust
// pillar decoration positions, status-bar chips, dialog frames) so
// caret / font-rendering jitter does not produce false positives. Raw
// editor content is excluded.
//
// CI policy:
//   * Tagged ``@visual`` so the default ``test:e2e:ci`` script
//     excludes it (matching the existing workflow.spec.ts pattern).
//   * Snapshots are regenerated locally via
//     ``test:e2e:update-snapshots`` and committed alongside the
//     source change that affects them.
//   * Chromium / macOS only — baselines are pinned to the primary
//     local environment.

import { expect, test } from "@playwright/test";

const MAX_DIFF_PIXEL_RATIO = 0.02;

async function readyWorkbench(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test.describe("@visual structural baselines", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Visual baselines are maintained only for Chromium.",
  );
  test.skip(
    process.platform !== "darwin",
    "Visual baselines are pinned to the primary local macOS environment.",
  );

  test("top bar layout", async ({ page }) => {
    await readyWorkbench(page);
    const topBar = page.getByLabel("Workbench Top Bar");
    await expect(topBar).toBeVisible();
    await expect(topBar).toHaveScreenshot("top-bar.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
  });

  test("activity bar", async ({ page }) => {
    await readyWorkbench(page);
    const activityBar = page.getByLabel("Activity Bar");
    await expect(activityBar).toBeVisible();
    await expect(activityBar).toHaveScreenshot("activity-bar.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
  });

  test("status bar", async ({ page }) => {
    await readyWorkbench(page);
    const statusBar = page.getByLabel("Status Bar");
    await expect(statusBar).toBeVisible();
    await expect(statusBar).toHaveScreenshot("status-bar.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
  });
});
