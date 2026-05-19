// Studio-IDE-12 (#250) — memory harness.
//
// Issue #250 §Memory SLA:
//   * After 50 transformation/run switches on a 1k-line fixture,
//     JS heap grows by ≤ 10 %.
//   * After 50 file switches in the generated tree, Monaco model
//     count returns to baseline (N+1, where N = currently open files).
//
// The harness drives the Studio through the same browser-only perf bridge
// used by @perf. Heap growth is sampled from Chromium's CDP heap counter after
// forced GC, falling back to browser-native memory APIs only when CDP is
// unavailable. Monaco model-count disposal is always enforced.

import { expect, test, type Page } from "@playwright/test";

import { buildSyntheticCobol } from "./helpers/syntheticCobol";

const HEAP_GROWTH_PCT_SLA = 10;
const WARMUP_ITERATIONS = 10;
const RECYCLE_ITERATIONS = 50;

interface MemorySample {
  bytes: number | null;
  source:
    | "cdp.Runtime.getHeapUsage"
    | "measureUserAgentSpecificMemory"
    | "performance.memory"
    | null;
}

interface MonacoHarness {
  __c2cEditorHarnessReady?: boolean;
  __c2cMonacoEditor?: {
    getDomNode: () => HTMLElement | null;
    getModel: () => {
      getLineCount: () => number;
      uri: { toString: () => string };
    } | null;
    getVisibleRanges: () => Array<{
      startLineNumber: number;
      endLineNumber: number;
    }>;
  };
  __c2cMonacoModelCount?: () => number;
  __c2cMonacoModelUris?: () => string[];
  __c2cEditorLifecycleStateCounts?: () => {
    viewStates: number;
    diffViewStates: number;
  };
}

async function sampleMemory(page: Page): Promise<MemorySample> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send("Runtime.getHeapUsage");
      if (typeof result.usedSize === "number" && result.usedSize > 0) {
        return {
          bytes: result.usedSize,
          source: "cdp.Runtime.getHeapUsage",
        };
      }
    } finally {
      await session.detach();
    }
  } catch {
    // CDP is Chromium-only. Keep browser-native fallbacks so the test still
    // reports a useful measurement if this config is run outside Chromium.
  }

  return page.evaluate(async () => {
    const w = window as unknown as {
      performance: {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
        memory?: { usedJSHeapSize?: number };
      };
    };
    if (typeof w.performance.measureUserAgentSpecificMemory !== "function") {
      const fallbackBytes = w.performance.memory?.usedJSHeapSize;
      return typeof fallbackBytes === "number" && fallbackBytes > 0
        ? { bytes: fallbackBytes, source: "performance.memory" as const }
        : { bytes: null, source: null };
    }
    try {
      const result = await w.performance.measureUserAgentSpecificMemory();
      return {
        bytes: result.bytes,
        source: "measureUserAgentSpecificMemory" as const,
      };
    } catch {
      const fallbackBytes = w.performance.memory?.usedJSHeapSize;
      return typeof fallbackBytes === "number" && fallbackBytes > 0
        ? { bytes: fallbackBytes, source: "performance.memory" as const }
        : { bytes: null, source: null };
    }
  });
}

async function collectGarbage(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("HeapProfiler.collectGarbage");
      await session.send("Runtime.evaluate", {
        expression: "globalThis.gc?.()",
        awaitPromise: true,
      });
      await session.send("HeapProfiler.collectGarbage");
    } finally {
      await session.detach();
    }
  } catch {
    // CDP GC is Chromium-only; when unavailable the sampler still reports
    // the best browser-provided measurement instead of hiding the test.
  }
  await page.waitForTimeout(1_000);
}

async function reloadAndRecycle(
  page: Page,
  source: string,
  iterations: number,
): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await loadCobolAndAwaitMount(page, source, `memory-recycle-${i}.cbl`);
    await clearEditorsAndAwaitTeardown(page);
  }
}

async function readyHarness(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("studio-workbench-shell")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => {
    const w = window as unknown as MonacoHarness;
    return w.__c2cEditorHarnessReady === true;
  });
}

async function loadCobolAndAwaitMount(
  page: Page,
  source: string,
  sourceName: string,
): Promise<void> {
  await page.evaluate(
    ({ sourceText, sourceName: nextSourceName }) => {
      window.dispatchEvent(
        new CustomEvent("c2c-perf:load-cobol", {
          detail: { sourceText, sourceName: nextSourceName },
        }),
      );
    },
    { sourceText: source, sourceName },
  );
  await page.waitForFunction(
    (expectedSourceName) => {
      const w = window as unknown as MonacoHarness;
      const editor = w.__c2cMonacoEditor;
      if (!editor) return false;
      const model = editor.getModel();
      const domNode = editor.getDomNode();
      const hasRenderedViewport = Boolean(
        domNode?.querySelector(".view-lines"),
      );
      const visibleRanges = editor.getVisibleRanges();
      return Boolean(
        model &&
          model.uri.toString().includes(String(expectedSourceName)) &&
          model.getLineCount() >= 1_000 &&
          hasRenderedViewport &&
          visibleRanges.some(
            (range) => range.endLineNumber >= range.startLineNumber,
          ),
      );
    },
    sourceName,
    { timeout: 30_000 },
  );
}

async function clearEditorsAndAwaitTeardown(
  page: Page,
): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("c2c-perf:clear-editors"));
  });
  await page.waitForFunction(() => {
    const w = window as unknown as MonacoHarness;
    return !w.__c2cMonacoEditor;
  });
}

async function getModelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as MonacoHarness;
    if (typeof w.__c2cMonacoModelCount !== "function") {
      throw new Error("Monaco model-count harness is unavailable.");
    }
    return w.__c2cMonacoModelCount();
  });
}

async function getLifecycleStateCounts(page: Page): Promise<{
  viewStates: number;
  diffViewStates: number;
} | null> {
  return page.evaluate(() => {
    const w = window as unknown as MonacoHarness;
    return typeof w.__c2cEditorLifecycleStateCounts === "function"
      ? w.__c2cEditorLifecycleStateCounts()
      : null;
  });
}

test.describe("@memory recycle pressure", () => {
  test("heap growth stays below 10% after 50 run switches", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 1_000 });
    await readyHarness(page);
    await reloadAndRecycle(page, source, WARMUP_ITERATIONS);
    await collectGarbage(page);

    const baseline = await sampleMemory(page);
    const baselineLifecycleCounts = await getLifecycleStateCounts(page);
    if (baseline.source === null) {
      console.warn(
        "[memory] no Chromium heap sampler is available in this context; the model-count SLA remains enforced by the companion test.",
      );
      test.skip(
        true,
        "No Chromium heap sampler is available in this context",
      );
      return;
    }

    await reloadAndRecycle(page, source, RECYCLE_ITERATIONS);
    await collectGarbage(page);
    const after = await sampleMemory(page);
    const afterLifecycleCounts = await getLifecycleStateCounts(page);
    expect(after.source).not.toBeNull();

    const growth = (after.bytes! - baseline.bytes!) / baseline.bytes!;
    const growthPct = growth * 100;

    console.log(
      `[memory] sampler=${baseline.source}, baseline=${baseline.bytes} bytes, after=${after.bytes} bytes, growth=${growthPct.toFixed(2)}% (SLA ${HEAP_GROWTH_PCT_SLA}%), lifecycle=${JSON.stringify({ baseline: baselineLifecycleCounts, after: afterLifecycleCounts })}`,
    );
    if (baselineLifecycleCounts && afterLifecycleCounts) {
      expect(afterLifecycleCounts.viewStates).toBeLessThanOrEqual(
        baselineLifecycleCounts.viewStates,
      );
      expect(afterLifecycleCounts.diffViewStates).toBeLessThanOrEqual(
        baselineLifecycleCounts.diffViewStates,
      );
    }
    expect(growthPct).toBeLessThan(HEAP_GROWTH_PCT_SLA);
  });

  test("Monaco model count returns to baseline after 50 file switches", async ({
    page,
  }) => {
    const source = buildSyntheticCobol({ targetLines: 1_000 });
    await readyHarness(page);

    await loadCobolAndAwaitMount(page, source, "memory-baseline.cbl");
    const activeBaseline = await getModelCount(page);
    expect(activeBaseline).toBeGreaterThan(0);

    for (let i = 0; i < RECYCLE_ITERATIONS; i += 1) {
      await loadCobolAndAwaitMount(page, source, `memory-switch-${i}.cbl`);
      const count = await getModelCount(page);
      expect(count).toBeLessThanOrEqual(activeBaseline + 1);
    }

    await clearEditorsAndAwaitTeardown(page);
    await expect
      .poll(() => getModelCount(page), {
        timeout: 15_000,
        message: "Monaco model count should return to the pre-editor baseline",
      })
      .toBeLessThanOrEqual(Math.max(0, activeBaseline - 1));
  });
});
