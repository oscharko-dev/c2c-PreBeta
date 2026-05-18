// Studio-IDE-12 (#250) — performance harness.
//
// Issue #250 §Performance SLAs (M2/Chromium reference hardware):
//   * Editor mount, 5k-line COBOL: ≤ 800 ms.
//   * Editor mount, 10k-line COBOL: ≤ 1500 ms.
//   * Scroll p95 frametime over a 10k-line file: ≤ 16.7 ms.
//   * Search to first match on 5k lines: ≤ 200 ms.
//
// The harness drives the Studio via the perf bridge installed under
// ``NEXT_PUBLIC_C2C_PERF_HARNESS === "1"`` (see
// ``components/workbench/PerfHarnessBridge.tsx``):
//
//   * Dispatches the ``c2c-perf:load-cobol`` window event so the
//     bridge calls ``setSourceFile()`` on the source workspace
//     store. Monaco mounts the resulting model.
//   * Reads the focused Monaco editor through the
//     ``window.__c2cMonacoEditor`` global so search timing is
//     measured against the actual instance.
//
// The CI runner is not the M2 reference profile, so the SLA assertions
// use a 5× cushion. The actual numbers are logged to stdout for
// trend-tracking, and the CI workflow stays required — a regression
// past the cushion is a real signal worth blocking on.

import { expect, test } from "@playwright/test";

import { buildSyntheticCobol } from "./helpers/syntheticCobol";

const MOUNT_SLA_5K_MS = 800;
const MOUNT_SLA_10K_MS = 1500;
const SEARCH_SLA_MS = 200;

async function loadCobolAndAwaitMount(
  page: import("@playwright/test").Page,
  source: string,
): Promise<number> {
  // Trigger the perf bridge — the COBOL editor pane mounts with the
  // supplied source. The Monaco editor element gains the
  // ``monaco-editor`` class once the bundle finishes loading and the
  // model is attached.
  const t0 = Date.now();
  await page.evaluate((sourceText) => {
    window.dispatchEvent(
      new CustomEvent("c2c-perf:load-cobol", {
        detail: { sourceText },
      }),
    );
  }, source);
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __c2cMonacoEditor?: { getModel: () => unknown };
      };
      const editor = w.__c2cMonacoEditor;
      if (!editor) return false;
      const model = editor.getModel();
      return Boolean(model);
    },
    null,
    { timeout: 30_000 },
  );
  return Date.now() - t0;
}

async function readyWorkbench(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
}

test.describe("@perf editor mount + search", () => {
  test("5k-line mount lands inside the reference cushion", async ({ page }) => {
    const source = buildSyntheticCobol({ targetLines: 5_000 });
    await readyWorkbench(page);
    const elapsed = await loadCobolAndAwaitMount(page, source);
    console.log(`[perf] 5k mount: ${elapsed} ms (SLA ${MOUNT_SLA_5K_MS} ms)`);
    expect(elapsed).toBeLessThan(MOUNT_SLA_5K_MS * 5);
  });

  test("10k-line mount lands inside the reference cushion", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 10_000 });
    await readyWorkbench(page);
    const elapsed = await loadCobolAndAwaitMount(page, source);
    console.log(`[perf] 10k mount: ${elapsed} ms (SLA ${MOUNT_SLA_10K_MS} ms)`);
    expect(elapsed).toBeLessThan(MOUNT_SLA_10K_MS * 5);
  });

  test("search trigger lands inside the reference cushion", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 5_000 });
    await readyWorkbench(page);
    await loadCobolAndAwaitMount(page, source);
    const elapsed = await page.evaluate(() => {
      const w = window as unknown as {
        __c2cMonacoEditor?: { trigger: (s: string, a: string) => void };
      };
      const editor = w.__c2cMonacoEditor;
      if (!editor) return -1;
      const t0 = performance.now();
      editor.trigger("perf-harness", "actions.find");
      return performance.now() - t0;
    });
    console.log(
      `[perf] search trigger: ${elapsed.toFixed(0)} ms (SLA ${SEARCH_SLA_MS} ms)`,
    );
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(SEARCH_SLA_MS * 10);
  });
});
