// Studio-IDE-12 (#250) — memory harness.
//
// Issue #250 §Memory SLA:
//   * After 50 transformation/run switches on a 1k-line fixture,
//     JS heap grows by ≤ 10 %.
//   * After 50 file switches in the generated tree, Monaco model
//     count returns to baseline (N+1, where N = currently open files).
//
// Implementation note: ``performance.measureUserAgentSpecificMemory()``
// requires a cross-origin-isolated context (COOP/COEP headers). Until
// the Studio's static asset hosting flips on those headers, this
// harness gracefully reports "API unavailable" instead of hard-
// failing — the test is gated under ``@memory`` so it stays
// non-blocking in CI per the issue spec.

import { expect, test } from "@playwright/test";

import { buildSyntheticCobol } from "./helpers/syntheticCobol";

const HEAP_GROWTH_PCT_SLA = 10;

interface MemorySample {
  bytes: number | null;
  apiAvailable: boolean;
}

async function sampleMemory(
  page: import("@playwright/test").Page,
): Promise<MemorySample> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      performance: {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      };
    };
    if (typeof w.performance.measureUserAgentSpecificMemory !== "function") {
      return { bytes: null, apiAvailable: false };
    }
    try {
      const result = await w.performance.measureUserAgentSpecificMemory();
      return { bytes: result.bytes, apiAvailable: true };
    } catch {
      return { bytes: null, apiAvailable: false };
    }
  });
}

async function reloadAndRecycle(
  page: import("@playwright/test").Page,
  source: string,
  iterations: number,
): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await page.evaluate((sourceText) => {
      window.dispatchEvent(
        new CustomEvent("c2c-perf:load-cobol", {
          detail: { sourceText },
        }),
      );
      window.dispatchEvent(new Event("c2c-perf:clear-editors"));
    }, source);
    // Yield to the event loop so any disposal handlers run.
    await page.waitForTimeout(20);
  }
}

test.describe("@memory recycle pressure", () => {
  test("heap growth stays below 10% after 50 run switches", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 1_000 });
    await page.goto("/");
    await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
    await page.waitForLoadState("networkidle");

    const baseline = await sampleMemory(page);
    if (!baseline.apiAvailable) {
      
      console.warn(
        "[memory] performance.measureUserAgentSpecificMemory() is unavailable in this context (COOP/COEP not enabled); skipping the SLA assertion. The harness still ran the 50-cycle recycle loop to exercise dispose paths.",
      );
      await reloadAndRecycle(page, source, 50);
      test.skip(
        true,
        "measureUserAgentSpecificMemory() requires a cross-origin-isolated context",
      );
      return;
    }

    await reloadAndRecycle(page, source, 50);
    // Allow any deferred GC to run. ``forceGc`` is not standard so
    // this is best-effort.
    await page.waitForTimeout(500);
    const after = await sampleMemory(page);

    const growth = (after.bytes! - baseline.bytes!) / baseline.bytes!;
    const growthPct = growth * 100;
    
    console.log(
      `[memory] baseline=${baseline.bytes} bytes, after=${after.bytes} bytes, growth=${growthPct.toFixed(2)}% (SLA ${HEAP_GROWTH_PCT_SLA}%)`,
    );
    expect(growthPct).toBeLessThan(HEAP_GROWTH_PCT_SLA);
  });
});
